<template>
  <div class="online-accounts-page">
    <section class="summary-grid">
      <el-card class="summary-card page-card" shadow="never">
        <span class="summary-card__label">总账号</span>
        <strong class="summary-card__value">{{ files.length }}</strong>
      </el-card>
      <el-card class="summary-card page-card" shadow="never">
        <span class="summary-card__label">有效</span>
        <strong class="summary-card__value">{{ countByStatus('active') }}</strong>
      </el-card>
      <el-card class="summary-card page-card" shadow="never">
        <span class="summary-card__label">禁用</span>
        <strong class="summary-card__value">{{ countByStatus('disabled') }}</strong>
      </el-card>
      <el-card class="summary-card page-card" shadow="never">
        <span class="summary-card__label">限额中</span>
        <strong class="summary-card__value">{{ usageLimitedCount }}</strong>
      </el-card>
      <el-card class="summary-card page-card" shadow="never">
        <span class="summary-card__label">Token 失效</span>
        <strong class="summary-card__value">{{ invalidTokenCount }}</strong>
      </el-card>
    </section>

    <el-card class="page-card" shadow="never">
      <template #header>
        <div class="toolbar">
          <div>
            <h3 class="page-title">线上账号管理</h3>
            <p class="page-subtitle">从线上服务获取账号列表，自动处理限额账号禁用/恢复，并支持清理 Token 失效账号。</p>
          </div>
          <div class="toolbar__actions">
            <el-button
              type="danger"
              plain
              :disabled="invalidFiles.length === 0"
              :loading="cleaningInvalid"
              @click="cleanAllInvalid"
            >
              清理全部失效 ({{ invalidFiles.length }})
            </el-button>
            <el-button :loading="loading" @click="loadFiles">刷新</el-button>
          </div>
        </div>
      </template>

      <div class="filters">
        <el-input
          v-model="searchText"
          clearable
          placeholder="搜索邮箱 / 账号"
        />
        <el-select v-model="filterStatus" clearable placeholder="全部状态">
          <el-option label="有效" value="active" />
          <el-option label="禁用" value="disabled" />
          <el-option label="限额中" value="usage_limited" />
          <el-option label="Token 失效" value="token_invalid" />
        </el-select>
      </div>

      <el-table
        v-loading="loading"
        :data="filteredFiles"
        row-key="id"
        stripe
        empty-text="暂无线上账号数据"
      >
        <el-table-column prop="account" label="邮箱" min-width="240" />
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row)" effect="light">
              {{ statusLabel(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="限额状态" width="120">
          <template #default="{ row }">
            <el-tag v-if="usageLimitState(row) === 'limited'" type="warning" effect="plain">限额中</el-tag>
            <el-tag v-else-if="usageLimitState(row) === 'recoverable'" type="info" effect="plain">待恢复</el-tag>
            <el-tag v-else-if="usageLimitState(row) === 'recovered'" type="success" effect="plain">已恢复</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="Token 状态" width="140">
          <template #default="{ row }">
            <el-tag v-if="isTokenInvalid(row)" type="danger" effect="plain">Token 失效</el-tag>
            <el-tag v-else type="success" effect="plain">正常</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="套餐" width="100">
          <template #default="{ row }">
            {{ row.id_token?.plan_type || '-' }}
          </template>
        </el-table-column>
        <el-table-column label="恢复时间" min-width="180">
          <template #default="{ row }">
            {{ formatRecoveryTime(row) }}
          </template>
        </el-table-column>
        <el-table-column label="创建时间" min-width="180">
          <template #default="{ row }">
            {{ formatDate(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column label="最后刷新" min-width="180">
          <template #default="{ row }">
            {{ formatDate(row.last_refresh) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="danger"
              :loading="deletingId === row.id"
              @click="deleteFile(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const MANAGEMENT_BASE = (() => {
  const url = import.meta.env.VITE_CPA_API_URL as string
  if (!url) return ''
  try { return new URL(url).origin } catch { return '' }
})()
const MANAGEMENT_TOKEN = import.meta.env.VITE_CPA_API_TOKEN as string

type IdToken = {
  chatgpt_account_id?: string
  plan_type?: string
}

type StatusMessagePayload = {
  error?: {
    code?: string
    type?: string
    resets_at?: number | string
    resets_in_seconds?: number | string
  }
}

type AuthFile = {
  id: string
  name: string
  account: string
  email: string
  status: string
  status_message: string
  disabled: boolean
  created_at: string
  last_refresh: string
  modtime: string
  id_token?: IdToken
  provider: string
  type: string
}

const files = ref<AuthFile[]>([])
const loading = ref(false)
const deletingId = ref<string | null>(null)
const cleaningInvalid = ref(false)
const searchText = ref('')
const filterStatus = ref('')

function isTokenInvalid(file: AuthFile): boolean {
  const payload = parseStatusMessage(file)
  if (!payload) return false
  return payload.error?.code === 'token_invalidated'
}

function parseStatusMessage(file: AuthFile): StatusMessagePayload | null {
  if (!file.status_message) return null
  try {
    return JSON.parse(file.status_message) as StatusMessagePayload
  } catch {
    return null
  }
}

const invalidFiles = computed(() => files.value.filter(isTokenInvalid))

function effectiveStatus(file: AuthFile): string {
  return file.disabled ? 'disabled' : file.status
}

function usageLimitState(file: AuthFile): 'none' | 'limited' | 'recoverable' | 'recovered' {
  if (!isUsageLimited(file)) {
    return 'none'
  }

  const resetAt = usageLimitResetAt(file)
  if (resetAt === null || resetAt > Date.now()) {
    return 'limited'
  }
  if (file.disabled) {
    return 'recoverable'
  }
  return 'recovered'
}

const filteredFiles = computed(() => {
  let result = files.value
  if (searchText.value) {
    const q = searchText.value.toLowerCase()
    result = result.filter(
      (f) => f.account.toLowerCase().includes(q) || f.email.toLowerCase().includes(q),
    )
  }
  if (filterStatus.value === 'token_invalid') {
    result = result.filter(isTokenInvalid)
  } else if (filterStatus.value === 'usage_limited') {
    result = result.filter((f) => usageLimitState(f) === 'limited')
  } else if (filterStatus.value) {
    result = result.filter((f) => effectiveStatus(f) === filterStatus.value)
  }
  return result
})

function countByStatus(status: string): number {
  return files.value.filter((f) => effectiveStatus(f) === status).length
}

const invalidTokenCount = computed(() => invalidFiles.value.length)
const usageLimitedCount = computed(() => files.value.filter((f) => usageLimitState(f) === 'limited').length)

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function usageLimitResetAt(file: AuthFile): number | null {
  const payload = parseStatusMessage(file)
  if (payload?.error?.type !== 'usage_limit_reached') {
    return null
  }

  const resetsAt = numberFromUnknown(payload.error.resets_at)
  if (resetsAt !== null && resetsAt > 0) {
    return resetsAt * 1000
  }

  const resetsInSeconds = numberFromUnknown(payload.error.resets_in_seconds)
  if (resetsInSeconds !== null) {
    return Date.now() + Math.max(resetsInSeconds, 0) * 1000
  }

  return null
}

function isUsageLimited(file: AuthFile): boolean {
  return parseStatusMessage(file)?.error?.type === 'usage_limit_reached'
}

function shouldAutoDisableForLimit(file: AuthFile): boolean {
  if (!isUsageLimited(file) || file.disabled) {
    return false
  }
  const resetAt = usageLimitResetAt(file)
  return resetAt === null || resetAt > Date.now()
}

function shouldAutoEnableAfterLimit(file: AuthFile): boolean {
  if (!file.disabled || !isUsageLimited(file)) {
    return false
  }
  const resetAt = usageLimitResetAt(file)
  return resetAt !== null && resetAt <= Date.now()
}

async function updateFileDisabledStatus(file: AuthFile, disabled: boolean) {
  const response = await fetch(`${MANAGEMENT_BASE}/v0/management/auth-files/status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: file.name,
      disabled,
    }),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
}

async function syncUsageLimitAccountStates(nextFiles: AuthFile[]): Promise<boolean> {
  let changed = false
  const failedAccounts: string[] = []

  for (const file of nextFiles) {
    const shouldDisable = shouldAutoDisableForLimit(file)
    const shouldEnable = !shouldDisable && shouldAutoEnableAfterLimit(file)
    if (!shouldDisable && !shouldEnable) {
      continue
    }

    try {
      await updateFileDisabledStatus(file, shouldDisable)
      changed = true
    } catch (e) {
      console.error('sync usage limit state failed', file.name, e)
      failedAccounts.push(file.account || file.email || file.name)
    }
  }

  if (failedAccounts.length > 0) {
    ElMessage.warning(`部分限额账号状态同步失败: ${failedAccounts.join('、')}`)
  }

  return changed
}

async function loadFiles(syncUsageLimit = true) {
  loading.value = true
  try {
    const response = await fetch(`${MANAGEMENT_BASE}/v0/management/auth-files`, {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as { files: AuthFile[] }
    const nextFiles = data.files ?? []

    if (syncUsageLimit) {
      const changed = await syncUsageLimitAccountStates(nextFiles)
      if (changed) {
        await loadFiles(false)
        return
      }
    }

    files.value = nextFiles
  } catch (e) {
    ElMessage.error('加载线上账号失败: ' + (e instanceof Error ? e.message : String(e)))
  } finally {
    loading.value = false
  }
}

async function deleteFile(file: AuthFile) {
  try {
    await ElMessageBox.confirm(
      `确定要删除账号 ${file.account} 吗？此操作不可撤销。`,
      '删除确认',
      { type: 'warning' },
    )
  } catch {
    return
  }

  deletingId.value = file.id
  try {
    const response = await fetch(
      `${MANAGEMENT_BASE}/v0/management/auth-files?name=${encodeURIComponent(file.name)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` } },
    )
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    ElMessage.success(`账号 ${file.account} 已删除`)
    await loadFiles()
  } catch (e) {
    ElMessage.error('删除失败: ' + (e instanceof Error ? e.message : String(e)))
  } finally {
    deletingId.value = null
  }
}

async function cleanAllInvalid() {
  const targets = invalidFiles.value
  if (targets.length === 0) return

  try {
    await ElMessageBox.confirm(
      `确定要删除全部 ${targets.length} 个 Token 失效账号吗？此操作不可撤销。`,
      '批量清理确认',
      { type: 'warning' },
    )
  } catch {
    return
  }

  cleaningInvalid.value = true
  let successCount = 0
  let failCount = 0
  try {
    for (const file of targets) {
      try {
        const response = await fetch(
          `${MANAGEMENT_BASE}/v0/management/auth-files?name=${encodeURIComponent(file.name)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` } },
        )
        if (response.ok) {
          successCount++
        } else {
          failCount++
        }
      } catch {
        failCount++
      }
    }
    ElMessage.success(`清理完成，成功 ${successCount}，失败 ${failCount}`)
    await loadFiles()
  } finally {
    cleaningInvalid.value = false
  }
}

function formatDate(value?: string) {
  if (!value) return '-'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatRecoveryTime(file: AuthFile) {
  const resetAt = usageLimitResetAt(file)
  if (resetAt === null) return '-'
  return formatDate(new Date(resetAt).toISOString())
}

function statusTagType(file: AuthFile) {
  if (usageLimitState(file) === 'limited') {
    return 'warning'
  }

  switch (effectiveStatus(file)) {
    case 'active':
      return 'success'
    case 'disabled':
      return 'info'
    default:
      return 'warning'
  }
}

function statusLabel(file: AuthFile) {
  if (usageLimitState(file) === 'limited' && file.disabled) {
    return '限额禁用'
  }
  if (usageLimitState(file) === 'limited') {
    return '限额中'
  }
  return effectiveStatus(file)
}

onMounted(() => {
  loadFiles()
})
</script>

<style scoped>
.online-accounts-page {
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
  grid-template-columns: minmax(0, 2fr) minmax(180px, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.page-title {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
}

.page-subtitle {
  margin: 0;
  font-size: 13px;
  color: #64748b;
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
}

@media (max-width: 640px) {
  .summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>
