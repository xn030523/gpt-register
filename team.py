"""
ChatGPT Registration - Team Subscription Flow
ChatGPT Team免费试用订阅流程，精确复刻HAR
"""

import logging
import json
import time
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Dict, Any, List
from urllib.parse import urlencode, urlparse, parse_qs

from . import config
from .client import HTTPClient
from .card import generate_card_info, generate_address, CardInfo, AddressInfo
from .pow import create_sentinel_token, POWSolver

logger = logging.getLogger(__name__)


@dataclass
class TeamSubscriptionResult:
    """Team订阅结果"""
    success: bool = False
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    subscription_id: Optional[str] = None
    plan_type: Optional[str] = None
    seats: int = 0
    active_until: Optional[str] = None
    checkout_url: Optional[str] = None
    stripe_session_id: Optional[str] = None
    card_info: Optional[Dict] = None
    error: Optional[str] = None
    raw_data: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "workspace_id": self.workspace_id,
            "workspace_name": self.workspace_name,
            "subscription_id": self.subscription_id,
            "plan_type": self.plan_type,
            "seats": self.seats,
            "active_until": self.active_until,
            "checkout_url": self.checkout_url,
            "card_info": self.card_info,
            "error": self.error,
        }


class TeamSubscriptionFlow:
    """
    ChatGPT Team订阅流程处理
    
    流程:
    1. 获取Sentinel Token (带POW)
    2. 创建Checkout Session (包含workspace_name)
    3. 重定向到Stripe支付页面
    4. 提交支付信息
    5. 支付成功回调
    6. 验证订阅状态
    """
    
    def __init__(
        self,
        client: HTTPClient,
        access_token: str,
        device_id: str,
        workspace_name: str = "MyTeam",
        seat_quantity: int = 5,
        country: str = "US",
        currency: str = "USD",
        bin_prefix: str = "6258142602",  # 默认韩国卡
        billing_country: str = "KR",  # 韩国地址
        email: Optional[str] = None,  # 新增邮箱
        # 代理参数
        proxy: Optional[str] = None,
        # 自定义卡片参数（来自卡片池）
        card_number: Optional[str] = None,
        card_expiry: Optional[str] = None,
        card_cvv: Optional[str] = None,
    ):
        self.client = client
        self.access_token = access_token
        self.device_id = device_id
        self.workspace_name = workspace_name
        self.seat_quantity = seat_quantity
        self.country = country
        self.currency = currency
        self.bin_prefix = bin_prefix
        self.billing_country = billing_country
        self.email = email
        self.proxy = proxy
        # 自定义卡片信息
        self.card_number = card_number
        self.card_expiry = card_expiry
        self.card_cvv = card_cvv
        
        # POW solver
        self.pow_solver = POWSolver(config.CHATGPT_HEADERS["user-agent"])
        
        # Result
        self.result = TeamSubscriptionResult()
        self.result.workspace_name = workspace_name
        self.result.seats = seat_quantity
    
    def _get_auth_headers(self) -> Dict[str, str]:
        """获取带认证的请求头"""
        headers = config.CHATGPT_HEADERS.copy()
        headers["authorization"] = f"Bearer {self.access_token}"
        headers["oai-device-id"] = self.device_id
        return headers
    
    def _get_sentinel_token(self, flow: str = "chatgpt_checkout") -> Optional[str]:
        """
        获取Sentinel Token
        POST /backend-api/sentinel/req
        """
        logger.info("Getting Sentinel token...")
        
        headers = self._get_auth_headers()
        headers["content-type"] = "application/json"
        
        # 生成POW数据
        pow_data = self.pow_solver.generate_pow_data()
        
        body = {
            "p": pow_data,
            "id": self.device_id,
            "flow": flow,
        }
        
        response = self.client.post(
            f"{config.CHATGPT_BASE}/backend-api/sentinel/req",
            json_data=body,
            headers=headers,
        )
        
        if response.status_code != 200:
            logger.error(f"Sentinel req failed: {response.status_code}")
            return None
        
        try:
            data = response.json()
            token = data.get("token")
            if token:
                logger.debug(f"Got Sentinel token: {token[:50]}...")
                return token
        except Exception as e:
            logger.error(f"Failed to parse sentinel response: {e}")
        
        return None
    
    def create_checkout_session(self) -> bool:
        """
        创建Checkout会话
        POST /backend-api/payments/checkout
        
        这是核心API，同时指定workspace_name，支付成功后后端自动创建workspace
        """
        logger.info("Creating checkout session...")
        
        headers = self._get_auth_headers()
        headers["content-type"] = "application/json"
        
        # 请求体（从HAR精确复制）
        body = {
            "plan_name": "chatgptteamplan",
            "team_plan_data": {
                "workspace_name": self.workspace_name,
                "price_interval": "month",
                "seat_quantity": self.seat_quantity,
            },
            "billing_details": {
                "country": self.country,
                "currency": self.currency,
            },
            "cancel_url": f"{config.CHATGPT_BASE}/?numSeats={self.seat_quantity}&selectedPlan=month#team-pricing-seat-selection",
            "promo_campaign": {
                "promo_campaign_id": "team-1-month-free",  # 免费试用优惠码
                "is_coupon_from_query_param": False,
            },
            "checkout_ui_mode": "redirect",
        }
        
        logger.debug(f"Checkout body: {json.dumps(body, indent=2)}")
        
        response = self.client.post(
            f"{config.CHATGPT_BASE}/backend-api/payments/checkout",
            json_data=body,
            headers=headers,
        )
        
        logger.debug(f"Checkout response status: {response.status_code}")
        
        if response.status_code != 200:
            try:
                error_data = response.json()
                error_str = str(error_data)
                if "account_deactivated" in error_str:
                    self.result.error = f"account_deactivated: {error_str}"
                elif "token_invalidated" in error_str:
                    self.result.error = f"token_invalidated: {error_str}"
                elif "account_not_found" in error_str or "does not exist" in error_str.lower():
                    self.result.error = f"account_not_found: {error_str}"
                else:
                    self.result.error = f"Checkout failed: {error_data}"
            except:
                self.result.error = f"Checkout failed: {response.status_code}"
            logger.error(self.result.error)
            return False
        
        try:
            data = response.json()
            logger.debug(f"Checkout response: {json.dumps(data, indent=2)[:1000]}")
            
            # 提取关键信息
            self.result.checkout_url = data.get("url")
            if self.result.checkout_url and "pay.openai.com/c/pay" in self.result.checkout_url:
                self.result.checkout_url = self.result.checkout_url.replace(
                    "https://pay.openai.com/c/pay", "https://checkout.stripe.com/c/pay"
                )
            self.result.stripe_session_id = data.get("checkout_session_id")
            self.result.raw_data["checkout_response"] = data
            self.result.raw_data["publishable_key"] = data.get("publishable_key")
            self.result.raw_data["processor_entity"] = data.get("processor_entity")
            
            if self.result.checkout_url:
                logger.info(f"Got checkout URL: {self.result.checkout_url[:80]}...")
                return True
            
        except Exception as e:
            self.result.error = f"Failed to parse checkout response: {e}"
            logger.error(self.result.error)
        
        return False
    
    def process_stripe_payment(self) -> bool:
        """
        处理Stripe支付
        这里使用纯API方式，不需要浏览器
        """
        if not self.result.checkout_url:
            self.result.error = "No checkout URL"
            return False
        
        logger.info("Processing Stripe payment...")
        
        # 生成卡片和地址
        card = generate_card_info(self.bin_prefix)
        address = generate_address(self.billing_country)
        
        logger.info(f"Card: {card.number_formatted} | {card.expiry} | CVV: {card.cvv}")
        logger.info(f"Address: {address.full_name}, {address.city}, {address.country}")
        
        self.result.card_info = {
            "number": card.number_formatted,
            "expiry": card.expiry,
            "cvv": card.cvv,
            "brand": card.brand,
            "billing_name": address.full_name,
            "billing_country": address.country,
        }
        
        # 初始化Stripe session
        publishable_key = self.result.raw_data.get("publishable_key", "")
        session_id = self.result.stripe_session_id
        
        if not session_id:
            # 从URL提取
            match = re.search(r"cs_live_[a-zA-Z0-9]+", self.result.checkout_url)
            if match:
                session_id = match.group(0)
        
        if not session_id:
            self.result.error = "Could not extract Stripe session ID"
            return False
        
        # Step 1: 初始化payment page
        init_url = f"https://api.stripe.com/v1/payment_pages/{session_id}/init"
        
        headers = {
            "accept": "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "origin": "https://pay.openai.com",
            "referer": self.result.checkout_url,
            "user-agent": config.CHATGPT_HEADERS["user-agent"],
        }
        
        init_data = urlencode({
            "key": publishable_key,
            "eid": "NA",
            "browser_locale": "zh-CN",
            "browser_timezone": "Asia/Shanghai",
            "redirect_type": "url",
        })
        
        response = self.client.post(init_url, data=init_data, headers=headers)
        
        if response.status_code != 200:
            logger.error(f"Stripe init failed: {response.status_code}")
            self.result.error = f"Stripe init failed: {response.status_code}"
            return False
        
        try:
            init_result = response.json()
            logger.debug(f"Stripe init: {str(init_result)[:500]}")
            
            # 保存session数据
            amount = init_result.get("amount_total", 0)
            currency = init_result.get("currency", "usd")
            
        except Exception as e:
            logger.error(f"Failed to parse Stripe init: {e}")
            amount = 0
            currency = "usd"
        
        # Step 2: 提交支付
        confirm_url = f"https://api.stripe.com/v1/payment_pages/{session_id}/confirm"
        
        confirm_data = {
            "key": publishable_key,
            "eid": "NA",
            "payment_method_data[type]": "card",
            "payment_method_data[card][number]": card.number,
            "payment_method_data[card][exp_month]": card.expiry.split("/")[0],
            "payment_method_data[card][exp_year]": f"20{card.expiry.split('/')[1]}",
            "payment_method_data[card][cvc]": card.cvv,
            "payment_method_data[billing_details][name]": address.full_name,
            "payment_method_data[billing_details][address][country]": address.country,
            "payment_method_data[billing_details][address][postal_code]": address.postal_code,
            "payment_method_data[billing_details][address][state]": address.province,
            "payment_method_data[billing_details][address][city]": address.city,
            "payment_method_data[billing_details][address][line1]": address.address,
            "expected_amount": amount,
        }
        
        if address.address_line2:
            confirm_data["payment_method_data[billing_details][address][line2]"] = address.address_line2
        
        response = self.client.post(
            confirm_url,
            data=urlencode(confirm_data),
            headers=headers,
        )
        
        logger.debug(f"Stripe confirm status: {response.status_code}")
        
        try:
            confirm_result = response.json()
            logger.debug(f"Stripe confirm: {str(confirm_result)[:500]}")
            
            self.result.raw_data["stripe_confirm"] = confirm_result
            
            # 检查是否需要3DS验证
            if confirm_result.get("next_action"):
                logger.warning("3DS verification required - not supported in API mode")
                self.result.error = "3DS verification required"
                return False
            
            # 检查支付状态
            status = confirm_result.get("status")
            if status in ("succeeded", "requires_capture"):
                logger.info("Stripe payment succeeded!")
                return True
            
            # 检查是否有redirect
            if confirm_result.get("redirect_url") or confirm_result.get("success_url"):
                logger.info("Stripe payment succeeded (redirect)")
                return True
            
        except Exception as e:
            logger.error(f"Failed to parse Stripe confirm: {e}")
        
        self.result.error = f"Stripe payment failed: {response.status_code}"
        return False
    
    def verify_subscription(self) -> bool:
        """
        验证订阅状态
        GET /backend-api/subscriptions?account_id={account_id}
        """
        logger.info("Verifying subscription...")
        
        # 首先获取account_id
        headers = self._get_auth_headers()
        
        response = self.client.get(
            f"{config.CHATGPT_BASE}/backend-api/accounts/check/v4-2023-04-27",
            params={"timezone_offset_min": "-480"},
            headers=headers,
        )
        
        if response.status_code != 200:
            logger.warning(f"Account check failed: {response.status_code}")
            return False
        
        try:
            data = response.json()
            accounts = data.get("accounts", {})
            
            # 找到team类型的account
            for account_id, account_data in accounts.items():
                account_info = account_data.get("account", {})
                plan_type = account_info.get("plan_type", "")
                structure = account_info.get("structure", "")
                
                # 检查plan_type是team或structure是workspace
                if plan_type == "team" or structure == "workspace":
                    self.result.workspace_id = account_id
                    logger.info(f"Found team account: {account_id} (plan_type={plan_type}, structure={structure})")
                    break
            
            if not self.result.workspace_id:
                logger.warning("No team account found")
                return False
            
        except Exception as e:
            logger.error(f"Failed to parse account check: {e}")
            return False
        
        # 获取订阅详情
        response = self.client.get(
            f"{config.CHATGPT_BASE}/backend-api/subscriptions",
            params={"account_id": self.result.workspace_id},
            headers=headers,
        )
        
        if response.status_code != 200:
            logger.warning(f"Subscription check failed: {response.status_code}")
            return False
        
        try:
            data = response.json()
            logger.debug(f"Subscription data: {json.dumps(data, indent=2)}")
            
            self.result.subscription_id = data.get("id")
            self.result.plan_type = data.get("plan_type")
            self.result.seats = data.get("seats_entitled", 0)
            self.result.active_until = data.get("active_until")
            self.result.raw_data["subscription"] = data
            
            if self.result.plan_type == "team":
                self.result.success = True
                logger.info(f"Team subscription verified! Expires: {self.result.active_until}")
                return True
            
        except Exception as e:
            logger.error(f"Failed to parse subscription: {e}")
        
        return False
    
    def configure_workspace(self) -> bool:
        """
        配置工作区设置
        POST /backend-api/accounts/{id}/settings/workspace_discoverable
        """
        if not self.result.workspace_id:
            return False
        
        logger.info("Configuring workspace settings...")
        
        headers = self._get_auth_headers()
        headers["content-type"] = "application/json"
        
        body = {
            "value": True,
            "public_display_name": None,
            "use_workspace_name_for_discovery": True,
        }
        
        response = self.client.post(
            f"{config.CHATGPT_BASE}/backend-api/accounts/{self.result.workspace_id}/settings/workspace_discoverable",
            json_data=body,
            headers=headers,
        )
        
        if response.status_code == 200:
            logger.info("Workspace configured successfully")
            return True
        
        logger.warning(f"Workspace config failed: {response.status_code}")
        return False
    
    def run(self, skip_payment: bool = False) -> TeamSubscriptionResult:
        """
        执行完整的Team订阅流程（同步，仅创建checkout）
        
        Args:
            skip_payment: 如果为True，只创建checkout会话，不尝试自动支付
                         （Stripe Hosted Checkout需要浏览器完成）
        """
        try:
            # Step 1: 创建Checkout会话
            if not self.create_checkout_session():
                return self.result
            
            if skip_payment:
                # 只返回checkout URL，需要手动或浏览器完成支付
                logger.info("Checkout session created. Payment URL ready.")
                logger.info(f"Checkout URL: {self.result.checkout_url}")
                self.result.error = "Payment requires browser (Stripe Hosted Checkout)"
                return self.result
            
            # Step 2: 尝试处理Stripe支付（可能失败，因为Hosted Checkout需要浏览器）
            if not self.process_stripe_payment():
                # 如果API支付失败，记录checkout URL供手动处理
                logger.warning("API payment failed. Use checkout URL for browser-based payment.")
                return self.result
            
            # Step 3: 等待后端处理
            logger.info("Waiting for backend to process payment...")
            time.sleep(3)
            
            # Step 4: 验证订阅状态
            for attempt in range(5):
                if self.verify_subscription():
                    break
                logger.info(f"Subscription not ready, retrying ({attempt + 1}/5)...")
                time.sleep(2)
            
            # Step 5: 配置工作区
            if self.result.success:
                self.configure_workspace()
            
        except Exception as e:
            logger.exception(f"Team subscription failed: {e}")
            self.result.error = str(e)
        
        return self.result
    
    async def run_with_browser(
        self,
        headless: bool = True,
        screenshot_dir: Optional[str] = None,
        timeout: int = 60,
    ) -> TeamSubscriptionResult:
        """
        执行完整的Team订阅流程（使用浏览器支付）
        
        Args:
            headless: 是否无头模式
            screenshot_dir: 截图保存目录
            timeout: 支付超时（秒）
        """
        try:
            # Step 1: 创建Checkout会话
            if not self.create_checkout_session():
                return self.result
            
            logger.info(f"Checkout URL: {self.result.checkout_url}")
            
            # Step 2: 使用浏览器完成支付
            from .browser import process_stripe_payment_browser
            
            browser_result = await process_stripe_payment_browser(
                checkout_url=self.result.checkout_url,
                bin_prefix=self.bin_prefix,
                billing_country=self.billing_country,
                headless=headless,
                screenshot_dir=screenshot_dir,
                timeout=timeout,
                email=self.email,
                # 传递代理参数
                proxy=self.proxy,
                # 传递自定义卡片参数（来自卡片池）
                card_number=self.card_number,
                card_expiry=self.card_expiry,
                card_cvv=self.card_cvv,
            )
            
            if not browser_result.success:
                self.result.error = f"Browser payment failed: {browser_result.error}"
                logger.error(self.result.error)
                return self.result
            
            # 浏览器支付成功，标记结果
            logger.info("Browser payment successful!")
            self.result.success = True
            
            # Step 3: 等待后端处理
            logger.info("Waiting for backend to process payment...")
            import asyncio
            await asyncio.sleep(5)
            
            # Step 4: 验证订阅状态（可选，即使失败也不影响整体成功）
            for attempt in range(5):
                if self.verify_subscription():
                    logger.info("Subscription verified!")
                    break
                logger.info(f"Subscription not ready, retrying ({attempt + 1}/5)...")
                await asyncio.sleep(2)
            
            # Step 5: 配置工作区
            if self.result.workspace_id:
                self.configure_workspace()
            
        except Exception as e:
            logger.exception(f"Team subscription failed: {e}")
            self.result.error = str(e)
        
        return self.result


def subscribe_team(
    client: HTTPClient,
    access_token: str,
    device_id: str,
    workspace_name: str = "MyTeam",
    seat_quantity: int = 5,
    country: str = "US",
    currency: str = "USD",
    bin_prefix: str = "6258142602",
    billing_country: str = "KR",
) -> TeamSubscriptionResult:
    """
    便捷函数：订阅ChatGPT Team
    
    Args:
        client: HTTP客户端
        access_token: 用户access token
        device_id: 设备ID
        workspace_name: 工作区名称
        seat_quantity: 席位数量（最少5）
        country: 账户国家
        currency: 货币
        bin_prefix: 银行卡BIN
        billing_country: 账单地址国家
        
    Returns:
        TeamSubscriptionResult
    """
    flow = TeamSubscriptionFlow(
        client=client,
        access_token=access_token,
        device_id=device_id,
        workspace_name=workspace_name,
        seat_quantity=seat_quantity,
        country=country,
        currency=currency,
        bin_prefix=bin_prefix,
        billing_country=billing_country,
    )
    return flow.run()
