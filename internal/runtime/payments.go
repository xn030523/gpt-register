package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	http "github.com/bogdanfinn/fhttp"
)

const (
	bindCardCheckoutEndpoint = "https://chatgpt.com/backend-api/payments/checkout"
	bindCardCheckoutBaseURL  = "https://chatgpt.com/checkout/openai_llc/"
)

type BindCardLinks struct {
	ShortURL string
	LongURL  string
}

func GenerateBindCardLink(ctx context.Context, accessToken, proxyURL string) (string, error) {
	data, err := requestBindCardCheckout(ctx, accessToken, proxyURL, "custom")
	if err != nil {
		return "", err
	}
	links := resolveCheckoutLinks(data)
	if strings.TrimSpace(links.ShortURL) == "" {
		return "", fmt.Errorf("未返回绑卡短链接")
	}
	return links.ShortURL, nil
}

func GenerateBindCardLinks(ctx context.Context, accessToken, proxyURL string) (BindCardLinks, error) {
	data, err := requestBindCardCheckout(ctx, accessToken, proxyURL, "redirect")
	if err != nil {
		return BindCardLinks{}, err
	}

	links := resolveCheckoutLinks(data)
	if strings.TrimSpace(links.ShortURL) == "" && strings.TrimSpace(links.LongURL) == "" {
		return BindCardLinks{}, fmt.Errorf("未返回绑卡链接")
	}
	return links, nil
}

func requestBindCardCheckout(ctx context.Context, accessToken, proxyURL, uiMode string) (map[string]any, error) {
	trimmedToken := strings.TrimSpace(accessToken)
	if trimmedToken == "" {
		return nil, fmt.Errorf("账号没有 access_token")
	}

	client, err := newTokenClient(proxyURL)
	if err != nil {
		return nil, err
	}

	payload := map[string]any{
		"plan_name": "chatgptteamplan",
		"team_plan_data": map[string]any{
			"workspace_name": "MyTeam",
			"price_interval": "month",
			"seat_quantity":  5,
		},
		"promo_campaign": map[string]any{
			"promo_campaign_id":          "team-1-month-free",
			"is_coupon_from_query_param": true,
		},
		"checkout_ui_mode": uiMode,
	}
	if uiMode == "redirect" {
		payload["billing_details"] = map[string]any{
			"country":  "US",
			"currency": "USD",
		}
		payload["cancel_url"] = "https://chatgpt.com/?numSeats=5&selectedPlan=month#team-pricing-seat-selection"
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, bindCardCheckoutEndpoint, strings.NewReader(string(body)))
	req.Header = browserHeaders(http.Header{
		"accept":             {"application/json, text/plain, */*"},
		"accept-language":    {"en-US,en;q=0.9"},
		"authorization":      {"Bearer " + trimmedToken},
		"content-type":       {"application/json"},
		"origin":             {"https://chatgpt.com"},
		"referer":            {"https://chatgpt.com/"},
		"sec-ch-ua":          {secCHUA()},
		"sec-ch-ua-mobile":   {"?0"},
		"sec-ch-ua-platform": {`"Windows"`},
		"sec-fetch-dest":     {"empty"},
		"sec-fetch-mode":     {"cors"},
		"sec-fetch-site":     {"same-origin"},
		"user-agent":         {userAgent()},
	}, "accept", "accept-language", "authorization", "content-type", "origin", "referer", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "user-agent")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	var data map[string]any
	_ = json.Unmarshal(respBody, &data)

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("%s", resolveCheckoutError(data, resp.StatusCode))
	}
	return data, nil
}

func resolveCheckoutURL(data map[string]any) string {
	links := resolveCheckoutLinks(data)
	if strings.TrimSpace(links.ShortURL) != "" {
		return links.ShortURL
	}
	return links.LongURL
}

func resolveCheckoutLinks(data map[string]any) BindCardLinks {
	shortURL := ""
	if value := strings.TrimSpace(asString(data["checkout_session_id"])); value != "" {
		shortURL = buildCheckoutURL(value)
	}

	longURL := normalizeCheckoutLongURL(asString(data["url"]))
	if shortURL == "" && longURL != "" {
		if match := checkoutSessionPattern.FindStringSubmatch(longURL); len(match) >= 2 {
			shortURL = buildCheckoutURL(match[1])
		}
	}

	return BindCardLinks{
		ShortURL: shortURL,
		LongURL:  longURL,
	}
}

func buildCheckoutURL(checkoutSessionID string) string {
	return bindCardCheckoutBaseURL + strings.TrimSpace(checkoutSessionID)
}

func normalizeCheckoutLongURL(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "https://pay.openai.com/c/pay") {
		return strings.Replace(trimmed, "https://pay.openai.com/c/pay", "https://checkout.stripe.com/c/pay", 1)
	}
	return trimmed
}

func resolveCheckoutError(data map[string]any, status int) string {
	for _, key := range []string{"detail", "message", "error"} {
		if value := strings.TrimSpace(asString(data[key])); value != "" {
			return value
		}
	}
	return fmt.Sprintf("HTTP %d", status)
}
