<template>
  <div class="accounts-page">
    <section class="summary-grid">
      <el-card class="summary-card page-card" shadow="never">
        <span class="summary-card__label">总账号</span>
        <strong class="summary-card__value">{{ stats.total }}</strong>
      </el-card>
      <el-card class="summary-card page-card" shadow="never">
        <span class="summary-card__label">有效</span>
        <strong class="summary-card__value">{{ stats.by_status.active ?? 0 }}</strong>
      </el-card>
      <el-card class="summary-card page-card" shadow="never">
        <span class="summary-card__label">过期</span>
        <strong class="summary-card__value">{{ stats.by_status.expired ?? 0 }}</strong>
      </el-card>
      <el-card class="summary-card page-card" shadow="never">
        <span class="summary-card__label">失败</span>
        <strong class="summary-card__value">{{ stats.by_status.failed ?? 0 }}</strong>
      </el-card>
    </section>

    <el-card class="page-card" shadow="never">
      <template #header>
        <div class="toolbar">
          <div>
            <h3 class="page-title">账号管理</h3>
            <p class="page-subtitle">账号查询、Token 刷新/校验和 CPA 上传都已经接到 Go 接口。</p>
          </div>
          <div class="toolbar__actions">
            <el-button :loading="loading" @click="refreshAll">刷新</el-button>
          </div>
        </div>
      </template>

      <div class="filters">
        <el-input
          v-model="filters.search"
          clearable
          placeholder="搜索邮箱 / 账号 ID / 工作区 ID"
          @keyup.enter="applyFilters"
        />
        <el-select v-model="filters.status" clearable placeholder="全部状态">
          <el-option
            v-for="option in statusOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-select v-model="filters.emailService" clearable placeholder="全部邮箱服务">
          <el-option
            v-for="option in serviceOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-button type="primary" @click="applyFilters">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>

      <div class="batch-actions">
        <el-button
          type="primary"
          plain
          :disabled="selectedIds.length === 0"
          :loading="batchAction === 'refresh'"
          @click="runBatchAction('refresh')"
        >
          刷新 Token
        </el-button>
        <el-button
          type="success"
          plain
          :disabled="selectedIds.length === 0"
          :loading="batchAction === 'validate'"
          @click="runBatchAction('validate')"
        >
          校验 Token
        </el-button>
        <el-button
          type="warning"
          plain
          :disabled="selectedIds.length === 0"
          :loading="batchAction === 'upload-cpa'"
          @click="runBatchAction('upload-cpa')"
        >
          上传 CPA
        </el-button>
        <span class="batch-actions__hint">
          已选 {{ selectedIds.length }} 项
        </span>
      </div>

      <el-table
        v-loading="loading"
        :data="rows"
        row-key="id"
        stripe
        empty-text="暂无账号数据"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="48" reserve-selection />
        <el-table-column prop="email" label="邮箱" min-width="240" />
        <el-table-column label="邮箱服务" min-width="140">
          <template #default="{ row }">
            {{ serviceLabel(row.email_service) }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" effect="light">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="注册时间" min-width="180">
          <template #default="{ row }">
            {{ formatDate(row.registered_at) }}
          </template>
        </el-table-column>
        <el-table-column label="过期时间" min-width="180">
          <template #default="{ row }">
            {{ formatDate(row.expires_at) }}
          </template>
        </el-table-column>
        <el-table-column label="CPA" width="100">
          <template #default="{ row }">
            <el-tag :type="row.cpa_uploaded ? 'success' : 'info'" effect="plain">
              {{ row.cpa_uploaded ? '已上传' : '未上传' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button
                link
                type="primary"
                :loading="actionLoading[row.id] === 'refresh'"
                @click="runRowAction(row, 'refresh')"
              >
                刷新
              </el-button>
              <el-button
                link
                type="success"
                :loading="actionLoading[row.id] === 'validate'"
                @click="runRowAction(row, 'validate')"
              >
                校验
              </el-button>
              <el-button
                link
                type="warning"
                :loading="actionLoading[row.id] === 'upload-cpa'"
                @click="runRowAction(row, 'upload-cpa')"
              >
                CPA
              </el-button>
              <el-button link type="info" @click="openDetail(row.id)">详情</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination">
        <el-pagination
          :current-page="filters.page"
          :page-size="filters.pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          background
          layout="total, sizes, prev, pager, next"
          @current-change="handlePageChange"
          @size-change="handlePageSizeChange"
        />
      </div>
    </el-card>

    <el-drawer v-model="detailVisible" title="账号详情" size="520px">
      <div v-loading="detailLoading" class="detail-panel">
        <template v-if="selectedAccount">
          <div class="detail-header">
            <div>
              <strong>{{ selectedAccount.email }}</strong>
              <p class="detail-header__subtitle">{{ serviceLabel(selectedAccount.email_service) }}</p>
            </div>
            <el-tag :type="statusTagType(selectedAccount.status)">
              {{ selectedAccount.status }}
            </el-tag>
          </div>

          <div class="detail-actions">
            <el-button
              type="primary"
              :loading="actionLoading[selectedAccount.id] === 'refresh'"
              @click="runRowAction(selectedAccount, 'refresh', true)"
            >
              刷新 Token
            </el-button>
            <el-button
              type="success"
              plain
              :loading="actionLoading[selectedAccount.id] === 'validate'"
              @click="runRowAction(selectedAccount, 'validate', true)"
            >
              校验 Token
            </el-button>
            <el-button
              type="warning"
              plain
              :loading="actionLoading[selectedAccount.id] === 'upload-cpa'"
              @click="runRowAction(selectedAccount, 'upload-cpa', true)"
            >
              上传 CPA
            </el-button>
            <el-button
              type="info"
              plain
              :loading="linkRegenerating"
              :disabled="!selectedTokens.access_token"
              @click="regenerateBindCardLinks"
            >
              重新生成链接
            </el-button>
          </div>

          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-item__label">账号 ID</span>
              <span>{{ selectedAccount.account_id || '-' }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item__label">工作区 ID</span>
              <span>{{ selectedAccount.workspace_id || '-' }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item__label">Client ID</span>
              <span>{{ selectedAccount.client_id || '-' }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item__label">代理</span>
              <span>{{ selectedAccount.proxy_used || '-' }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item__label">注册时间</span>
              <span>{{ formatDate(selectedAccount.registered_at) }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item__label">刷新时间</span>
              <span>{{ formatDate(selectedAccount.last_refresh) }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item__label">过期时间</span>
              <span>{{ formatDate(selectedAccount.expires_at) }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-item__label">CPA 时间</span>
              <span>{{ formatDate(selectedAccount.cpa_uploaded_at) }}</span>
            </div>
          </div>

          <el-divider content-position="left">Token 摘要</el-divider>
          <div class="token-grid">
            <div class="token-card">
              <div class="token-card__header">
                <span class="detail-item__label">Access Token</span>
                <el-button
                  link
                  type="primary"
                  :disabled="!selectedTokens.access_token"
                  @click="copyValue(selectedTokens.access_token, 'Access Token')"
                >
                  复制
                </el-button>
              </div>
              <code>{{ selectedTokens.access_token_summary || '-' }}</code>
            </div>
            <div class="token-card">
              <div class="token-card__header">
                <span class="detail-item__label">Refresh Token</span>
                <el-button
                  link
                  type="primary"
                  :disabled="!selectedTokens.refresh_token"
                  @click="copyValue(selectedTokens.refresh_token, 'Refresh Token')"
                >
                  复制
                </el-button>
              </div>
              <code>{{ selectedTokens.refresh_token_summary || '-' }}</code>
            </div>
            <div class="token-card">
              <div class="token-card__header">
                <span class="detail-item__label">ID Token</span>
                <el-button
                  link
                  type="primary"
                  :disabled="!selectedTokens.id_token"
                  @click="copyValue(selectedTokens.id_token, 'ID Token')"
                >
                  复制
                </el-button>
              </div>
              <code>{{ selectedTokens.id_token_summary || '-' }}</code>
            </div>
            <div class="token-card">
              <div class="token-card__header">
                <span class="detail-item__label">绑卡短链</span>
                <el-button
                  link
                  type="primary"
                  :disabled="!selectedTokens.bind_card_url"
                  @click="copyValue(selectedTokens.bind_card_url, '绑卡短链')"
                >
                  复制
                </el-button>
              </div>
              <code>{{ selectedTokens.bind_card_url_summary || '-' }}</code>
            </div>
            <div class="token-card">
              <div class="token-card__header">
                <span class="detail-item__label">绑卡长链</span>
                <el-button
                  link
                  type="primary"
                  :disabled="!selectedTokens.bind_card_long_url"
                  @click="copyValue(selectedTokens.bind_card_long_url, '绑卡长链')"
                >
                  复制
                </el-button>
              </div>
              <code>{{ selectedTokens.bind_card_long_url_summary || '-' }}</code>
            </div>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

type Account = {
  id: number
  email: string
  password?: string
  client_id?: string
  email_service: string
  account_id?: string
  workspace_id?: string
  registered_at?: string
  last_refresh?: string
  expires_at?: string
  status: string
  proxy_used?: string
  cpa_uploaded: boolean
  cpa_uploaded_at?: string
  created_at?: string
  updated_at?: string
}

type AccountStats = {
  total: number
  by_status: Record<string, number>
  by_email_service: Record<string, number>
}

type AccountTokens = {
  access_token?: string | null
  access_token_summary?: string | null
  refresh_token?: string | null
  refresh_token_summary?: string | null
  id_token?: string | null
  id_token_summary?: string | null
  bind_card_url?: string | null
  bind_card_url_summary?: string | null
  bind_card_long_url?: string | null
  bind_card_long_url_summary?: string | null
  has_tokens?: boolean
}

type BatchAction = 'refresh' | 'validate' | 'upload-cpa'

const rows = ref<Account[]>([])
const total = ref(0)
const loading = ref(false)
const detailLoading = ref(false)
const detailVisible = ref(false)
const linkRegenerating = ref(false)
const selectedAccount = ref<Account | null>(null)
const selectedTokens = ref<AccountTokens>({})
const selectedIds = ref<number[]>([])
const batchAction = ref<BatchAction | ''>('')
const actionLoading = reactive<Record<number, '' | BatchAction>>({})
const stats = reactive<AccountStats>({
  total: 0,
  by_status: {},
  by_email_service: {},
})

const filters = reactive({
  search: '',
  status: '',
  emailService: '',
  page: 1,
  pageSize: 10,
})

const statusOptions = [
  { label: '有效', value: 'active' },
  { label: '过期', value: 'expired' },
  { label: '封禁', value: 'banned' },
  { label: '失败', value: 'failed' },
]

const serviceOptions = [{ label: '临时邮箱', value: 'tempmail' }]

async function refreshAll() {
  loading.value = true
  try {
    await Promise.all([loadStats(), loadAccounts()])
  } catch {
    ElMessage.error('加载账号数据失败')
  } finally {
    loading.value = false
  }
}

async function loadAccounts() {
  const params = new URLSearchParams({
    page: String(filters.page),
    page_size: String(filters.pageSize),
  })

  if (filters.search) {
    params.set('search', filters.search)
  }
  if (filters.status) {
    params.set('status', filters.status)
  }
  if (filters.emailService) {
    params.set('email_service', filters.emailService)
  }

  const response = await fetch(`/api/accounts?${params.toString()}`)
  if (!response.ok) {
    throw new Error('load accounts failed')
  }

  const payload = (await response.json()) as { total: number; accounts: Account[] }
  rows.value = payload.accounts ?? []
  total.value = payload.total ?? 0
}

async function loadStats() {
  const response = await fetch('/api/accounts/stats/summary')
  if (!response.ok) {
    throw new Error('load account stats failed')
  }

  const payload = (await response.json()) as AccountStats
  stats.total = payload.total ?? 0
  stats.by_status = payload.by_status ?? {}
  stats.by_email_service = payload.by_email_service ?? {}
}

async function openDetail(id: number) {
  detailVisible.value = true
  detailLoading.value = true
  selectedAccount.value = null
  selectedTokens.value = {}

  try {
    const [accountResponse, tokenResponse] = await Promise.all([fetch(`/api/accounts/${id}`), fetchAccountTokens(id)])
    if (!accountResponse.ok || !tokenResponse.ok) {
      throw new Error('load account detail failed')
    }

    selectedAccount.value = (await accountResponse.json()) as Account
    selectedTokens.value = (await tokenResponse.json()) as AccountTokens
  } catch {
    selectedAccount.value = null
    selectedTokens.value = {}
    ElMessage.error('加载账号详情失败')
  } finally {
    detailLoading.value = false
  }
}

async function fetchAccountTokens(id: number) {
  return fetch(`/api/accounts/${id}/tokens`)
}

async function regenerateBindCardLinks() {
  const accountID = selectedAccount.value?.id
  if (!accountID) {
    return
  }

  linkRegenerating.value = true
  try {
    const response = await fetch(`/api/accounts/${accountID}/tokens/regenerate-links`, {
      method: 'POST',
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(payload.error || 'regenerate bind card links failed')
    }

    selectedTokens.value = (await response.json()) as AccountTokens
    ElMessage.success('绑卡链接已重新生成')
  } catch (error) {
    const message = error instanceof Error ? error.message : '重新生成绑卡链接失败'
    ElMessage.error(message)
  } finally {
    linkRegenerating.value = false
  }
}

async function runRowAction(account: Account, action: BatchAction, reloadDetail = false) {
  actionLoading[account.id] = action
  try {
    const response = await fetch(`/api/accounts/${account.id}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    if (!response.ok) {
      throw new Error('request failed')
    }

    const payload = (await response.json()) as {
      success?: boolean
      valid?: boolean
      message?: string
      error?: string
    }

    if (action === 'validate') {
      if (payload.valid) {
        ElMessage.success(`账号 ${account.email} Token 有效`)
      } else {
        ElMessage.warning(payload.error || `账号 ${account.email} Token 无效`)
      }
    } else if (payload.success) {
      ElMessage.success(payload.message || actionSuccessText(action))
    } else {
      ElMessage.error(payload.error || `${actionSuccessText(action)}失败`)
    }

    await refreshAll()
    if (reloadDetail && selectedAccount.value?.id === account.id) {
      await openDetail(account.id)
    }
  } catch {
    ElMessage.error(`${actionSuccessText(action)}失败`)
  } finally {
    actionLoading[account.id] = ''
  }
}

async function runBatchAction(action: BatchAction) {
  if (selectedIds.value.length === 0) {
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定对选中的 ${selectedIds.value.length} 个账号执行${actionConfirmText(action)}吗？`,
      '批量操作确认',
      { type: 'warning' },
    )
  } catch {
    return
  }

  batchAction.value = action
  try {
    const response = await fetch(`/api/accounts/batch-${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: selectedIds.value }),
    })
    if (!response.ok) {
      throw new Error('request failed')
    }

    const payload = (await response.json()) as Record<string, unknown>
    ElMessage.success(buildBatchMessage(action, payload))
    await refreshAll()
  } catch {
    ElMessage.error(`${actionConfirmText(action)}失败`)
  } finally {
    batchAction.value = ''
  }
}

async function copyValue(value: string | null | undefined, label: string) {
  const trimmed = value?.trim()
  if (!trimmed) {
    ElMessage.warning(`${label} 不可复制`)
    return
  }

  try {
    await writeClipboard(trimmed)
    ElMessage.success(`${label} 已复制`)
  } catch {
    ElMessage.error(`${label} 复制失败`)
  }
}

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function applyFilters() {
  filters.page = 1
  refreshAll()
}

function resetFilters() {
  filters.search = ''
  filters.status = ''
  filters.emailService = ''
  filters.page = 1
  refreshAll()
}

function handlePageChange(page: number) {
  filters.page = page
  refreshAll()
}

function handlePageSizeChange(pageSize: number) {
  filters.pageSize = pageSize
  filters.page = 1
  refreshAll()
}

function handleSelectionChange(selection: Account[]) {
  selectedIds.value = selection.map((item) => item.id)
}

function formatDate(value?: string) {
  if (!value) {
    return '-'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusTagType(status: string) {
  switch (status) {
    case 'active':
      return 'success'
    case 'expired':
      return 'warning'
    case 'banned':
      return 'danger'
    case 'failed':
      return 'info'
    default:
      return 'info'
  }
}

function serviceLabel(service: string) {
  if (service === 'tempmail' || service === 'temp-email' || service === 'meteormail') {
    return '临时邮箱'
  }
  return service || '-'
}

function actionSuccessText(action: BatchAction) {
  switch (action) {
    case 'refresh':
      return '刷新 Token'
    case 'validate':
      return '校验 Token'
    case 'upload-cpa':
      return '上传 CPA'
  }
}

function actionConfirmText(action: BatchAction) {
  switch (action) {
    case 'refresh':
      return '刷新 Token'
    case 'validate':
      return '校验 Token'
    case 'upload-cpa':
      return '上传到 CPA'
  }
}

function buildBatchMessage(action: BatchAction, payload: Record<string, unknown>) {
  if (action === 'refresh') {
    return `刷新完成，成功 ${Number(payload.success_count ?? 0)}，失败 ${Number(payload.failed_count ?? 0)}`
  }
  if (action === 'validate') {
    return `校验完成，有效 ${Number(payload.valid_count ?? 0)}，无效 ${Number(payload.invalid_count ?? 0)}`
  }
  return `上传完成，成功 ${Number(payload.success_count ?? 0)}，失败 ${Number(payload.failed_count ?? 0)}，跳过 ${Number(payload.skipped_count ?? 0)}`
}

onMounted(() => {
  refreshAll()
})
</script>

<style scoped>
.accounts-page {
  display: grid;
  gap: 20px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px;
}

.summary-card {
  display: grid;
  gap: 8px;
}

.summary-card__label {
  color: #52606d;
  font-size: 14px;
}

.summary-card__value {
  font-size: 30px;
  line-height: 1;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.toolbar__actions {
  display: flex;
  gap: 12px;
}

.filters {
  display: grid;
  grid-template-columns: minmax(0, 2fr) repeat(2, minmax(180px, 1fr)) auto auto;
  gap: 12px;
  margin-bottom: 16px;
}

.batch-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.batch-actions__hint {
  color: #52606d;
  font-size: 13px;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
}

.detail-panel {
  display: grid;
  gap: 18px;
}

.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.detail-header__subtitle {
  margin: 8px 0 0;
  color: #64748b;
}

.detail-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.detail-item {
  display: grid;
  gap: 6px;
}

.detail-item__label {
  color: #52606d;
  font-size: 13px;
}

.token-grid {
  display: grid;
  gap: 12px;
}

.token-card {
  display: grid;
  gap: 8px;
  padding: 14px;
  border-radius: 14px;
  background: #f8fafc;
}

.token-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.token-card code {
  font-size: 12px;
  word-break: break-all;
  white-space: pre-wrap;
}

@media (max-width: 900px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .toolbar {
    flex-direction: column;
    align-items: flex-start;
  }

  .filters {
    grid-template-columns: 1fr;
  }

  .pagination {
    justify-content: flex-start;
  }

  .detail-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>
