import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
const MANAGEMENT_BASE = (() => {
    const url = import.meta.env.VITE_CPA_API_URL;
    if (!url)
        return '';
    try {
        return new URL(url).origin;
    }
    catch {
        return '';
    }
})();
const MANAGEMENT_TOKEN = import.meta.env.VITE_CPA_API_TOKEN;
const files = ref([]);
const loading = ref(false);
const deletingId = ref(null);
const cleaningInvalid = ref(false);
const searchText = ref('');
const filterStatus = ref('');
function isTokenInvalid(file) {
    const payload = parseStatusMessage(file);
    if (!payload)
        return false;
    return payload.error?.code === 'token_invalidated';
}
function parseStatusMessage(file) {
    if (!file.status_message)
        return null;
    try {
        return JSON.parse(file.status_message);
    }
    catch {
        return null;
    }
}
const invalidFiles = computed(() => files.value.filter(isTokenInvalid));
function effectiveStatus(file) {
    return file.disabled ? 'disabled' : file.status;
}
function usageLimitState(file) {
    if (!isUsageLimited(file)) {
        return 'none';
    }
    const resetAt = usageLimitResetAt(file);
    if (resetAt === null || resetAt > Date.now()) {
        return 'limited';
    }
    if (file.disabled) {
        return 'recoverable';
    }
    return 'recovered';
}
const filteredFiles = computed(() => {
    let result = files.value;
    if (searchText.value) {
        const q = searchText.value.toLowerCase();
        result = result.filter((f) => f.account.toLowerCase().includes(q) || f.email.toLowerCase().includes(q));
    }
    if (filterStatus.value === 'token_invalid') {
        result = result.filter(isTokenInvalid);
    }
    else if (filterStatus.value === 'usage_limited') {
        result = result.filter((f) => usageLimitState(f) === 'limited');
    }
    else if (filterStatus.value) {
        result = result.filter((f) => effectiveStatus(f) === filterStatus.value);
    }
    return result;
});
function countByStatus(status) {
    return files.value.filter((f) => effectiveStatus(f) === status).length;
}
const invalidTokenCount = computed(() => invalidFiles.value.length);
const usageLimitedCount = computed(() => files.value.filter((f) => usageLimitState(f) === 'limited').length);
function numberFromUnknown(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
function usageLimitResetAt(file) {
    const payload = parseStatusMessage(file);
    if (payload?.error?.type !== 'usage_limit_reached') {
        return null;
    }
    const resetsAt = numberFromUnknown(payload.error.resets_at);
    if (resetsAt !== null && resetsAt > 0) {
        return resetsAt * 1000;
    }
    const resetsInSeconds = numberFromUnknown(payload.error.resets_in_seconds);
    if (resetsInSeconds !== null) {
        return Date.now() + Math.max(resetsInSeconds, 0) * 1000;
    }
    return null;
}
function isUsageLimited(file) {
    return parseStatusMessage(file)?.error?.type === 'usage_limit_reached';
}
function shouldAutoDisableForLimit(file) {
    if (!isUsageLimited(file) || file.disabled) {
        return false;
    }
    const resetAt = usageLimitResetAt(file);
    return resetAt === null || resetAt > Date.now();
}
function shouldAutoEnableAfterLimit(file) {
    if (!file.disabled || !isUsageLimited(file)) {
        return false;
    }
    const resetAt = usageLimitResetAt(file);
    return resetAt !== null && resetAt <= Date.now();
}
async function updateFileDisabledStatus(file, disabled) {
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
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
}
async function syncUsageLimitAccountStates(nextFiles) {
    let changed = false;
    const failedAccounts = [];
    for (const file of nextFiles) {
        const shouldDisable = shouldAutoDisableForLimit(file);
        const shouldEnable = !shouldDisable && shouldAutoEnableAfterLimit(file);
        if (!shouldDisable && !shouldEnable) {
            continue;
        }
        try {
            await updateFileDisabledStatus(file, shouldDisable);
            changed = true;
        }
        catch (e) {
            console.error('sync usage limit state failed', file.name, e);
            failedAccounts.push(file.account || file.email || file.name);
        }
    }
    if (failedAccounts.length > 0) {
        ElMessage.warning(`部分限额账号状态同步失败: ${failedAccounts.join('、')}`);
    }
    return changed;
}
async function loadFiles(syncUsageLimit = true) {
    loading.value = true;
    try {
        const response = await fetch(`${MANAGEMENT_BASE}/v0/management/auth-files`, {
            headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json());
        const nextFiles = data.files ?? [];
        if (syncUsageLimit) {
            const changed = await syncUsageLimitAccountStates(nextFiles);
            if (changed) {
                await loadFiles(false);
                return;
            }
        }
        files.value = nextFiles;
    }
    catch (e) {
        ElMessage.error('加载线上账号失败: ' + (e instanceof Error ? e.message : String(e)));
    }
    finally {
        loading.value = false;
    }
}
async function deleteFile(file) {
    try {
        await ElMessageBox.confirm(`确定要删除账号 ${file.account} 吗？此操作不可撤销。`, '删除确认', { type: 'warning' });
    }
    catch {
        return;
    }
    deletingId.value = file.id;
    try {
        const response = await fetch(`${MANAGEMENT_BASE}/v0/management/auth-files?name=${encodeURIComponent(file.name)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` } });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        ElMessage.success(`账号 ${file.account} 已删除`);
        await loadFiles();
    }
    catch (e) {
        ElMessage.error('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
    finally {
        deletingId.value = null;
    }
}
async function cleanAllInvalid() {
    const targets = invalidFiles.value;
    if (targets.length === 0)
        return;
    try {
        await ElMessageBox.confirm(`确定要删除全部 ${targets.length} 个 Token 失效账号吗？此操作不可撤销。`, '批量清理确认', { type: 'warning' });
    }
    catch {
        return;
    }
    cleaningInvalid.value = true;
    let successCount = 0;
    let failCount = 0;
    try {
        for (const file of targets) {
            try {
                const response = await fetch(`${MANAGEMENT_BASE}/v0/management/auth-files?name=${encodeURIComponent(file.name)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` } });
                if (response.ok) {
                    successCount++;
                }
                else {
                    failCount++;
                }
            }
            catch {
                failCount++;
            }
        }
        ElMessage.success(`清理完成，成功 ${successCount}，失败 ${failCount}`);
        await loadFiles();
    }
    finally {
        cleaningInvalid.value = false;
    }
}
function formatDate(value) {
    if (!value)
        return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        return value;
    return parsed.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}
function formatRecoveryTime(file) {
    const resetAt = usageLimitResetAt(file);
    if (resetAt === null)
        return '-';
    return formatDate(new Date(resetAt).toISOString());
}
function statusTagType(file) {
    if (usageLimitState(file) === 'limited') {
        return 'warning';
    }
    switch (effectiveStatus(file)) {
        case 'active':
            return 'success';
        case 'disabled':
            return 'info';
        default:
            return 'warning';
    }
}
function statusLabel(file) {
    if (usageLimitState(file) === 'limited' && file.disabled) {
        return '限额禁用';
    }
    if (usageLimitState(file) === 'limited') {
        return '限额中';
    }
    return effectiveStatus(file);
}
onMounted(() => {
    loadFiles();
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['summary-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['filters']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-grid']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "online-accounts-page" },
});
/** @type {__VLS_StyleScopedClasses['online-accounts-page']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "summary-grid" },
});
/** @type {__VLS_StyleScopedClasses['summary-grid']} */ ;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.elCard | typeof __VLS_components.ElCard | typeof __VLS_components.elCard | typeof __VLS_components.ElCard} */
elCard;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}));
const __VLS_2 = __VLS_1({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
/** @type {__VLS_StyleScopedClasses['summary-card']} */ ;
/** @type {__VLS_StyleScopedClasses['page-card']} */ ;
const { default: __VLS_5 } = __VLS_3.slots;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "summary-card__label" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({
    ...{ class: "summary-card__value" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__value']} */ ;
(__VLS_ctx.files.length);
// @ts-ignore
[files,];
var __VLS_3;
let __VLS_6;
/** @ts-ignore @type {typeof __VLS_components.elCard | typeof __VLS_components.ElCard | typeof __VLS_components.elCard | typeof __VLS_components.ElCard} */
elCard;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}));
const __VLS_8 = __VLS_7({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
/** @type {__VLS_StyleScopedClasses['summary-card']} */ ;
/** @type {__VLS_StyleScopedClasses['page-card']} */ ;
const { default: __VLS_11 } = __VLS_9.slots;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "summary-card__label" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({
    ...{ class: "summary-card__value" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__value']} */ ;
(__VLS_ctx.countByStatus('active'));
// @ts-ignore
[countByStatus,];
var __VLS_9;
let __VLS_12;
/** @ts-ignore @type {typeof __VLS_components.elCard | typeof __VLS_components.ElCard | typeof __VLS_components.elCard | typeof __VLS_components.ElCard} */
elCard;
// @ts-ignore
const __VLS_13 = __VLS_asFunctionalComponent1(__VLS_12, new __VLS_12({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}));
const __VLS_14 = __VLS_13({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}, ...__VLS_functionalComponentArgsRest(__VLS_13));
/** @type {__VLS_StyleScopedClasses['summary-card']} */ ;
/** @type {__VLS_StyleScopedClasses['page-card']} */ ;
const { default: __VLS_17 } = __VLS_15.slots;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "summary-card__label" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({
    ...{ class: "summary-card__value" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__value']} */ ;
(__VLS_ctx.countByStatus('disabled'));
// @ts-ignore
[countByStatus,];
var __VLS_15;
let __VLS_18;
/** @ts-ignore @type {typeof __VLS_components.elCard | typeof __VLS_components.ElCard | typeof __VLS_components.elCard | typeof __VLS_components.ElCard} */
elCard;
// @ts-ignore
const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}));
const __VLS_20 = __VLS_19({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}, ...__VLS_functionalComponentArgsRest(__VLS_19));
/** @type {__VLS_StyleScopedClasses['summary-card']} */ ;
/** @type {__VLS_StyleScopedClasses['page-card']} */ ;
const { default: __VLS_23 } = __VLS_21.slots;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "summary-card__label" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({
    ...{ class: "summary-card__value" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__value']} */ ;
(__VLS_ctx.usageLimitedCount);
// @ts-ignore
[usageLimitedCount,];
var __VLS_21;
let __VLS_24;
/** @ts-ignore @type {typeof __VLS_components.elCard | typeof __VLS_components.ElCard | typeof __VLS_components.elCard | typeof __VLS_components.ElCard} */
elCard;
// @ts-ignore
const __VLS_25 = __VLS_asFunctionalComponent1(__VLS_24, new __VLS_24({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}));
const __VLS_26 = __VLS_25({
    ...{ class: "summary-card page-card" },
    shadow: "never",
}, ...__VLS_functionalComponentArgsRest(__VLS_25));
/** @type {__VLS_StyleScopedClasses['summary-card']} */ ;
/** @type {__VLS_StyleScopedClasses['page-card']} */ ;
const { default: __VLS_29 } = __VLS_27.slots;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "summary-card__label" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({
    ...{ class: "summary-card__value" },
});
/** @type {__VLS_StyleScopedClasses['summary-card__value']} */ ;
(__VLS_ctx.invalidTokenCount);
// @ts-ignore
[invalidTokenCount,];
var __VLS_27;
let __VLS_30;
/** @ts-ignore @type {typeof __VLS_components.elCard | typeof __VLS_components.ElCard | typeof __VLS_components.elCard | typeof __VLS_components.ElCard} */
elCard;
// @ts-ignore
const __VLS_31 = __VLS_asFunctionalComponent1(__VLS_30, new __VLS_30({
    ...{ class: "page-card" },
    shadow: "never",
}));
const __VLS_32 = __VLS_31({
    ...{ class: "page-card" },
    shadow: "never",
}, ...__VLS_functionalComponentArgsRest(__VLS_31));
/** @type {__VLS_StyleScopedClasses['page-card']} */ ;
const { default: __VLS_35 } = __VLS_33.slots;
{
    const { header: __VLS_36 } = __VLS_33.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "toolbar" },
    });
    /** @type {__VLS_StyleScopedClasses['toolbar']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
        ...{ class: "page-title" },
    });
    /** @type {__VLS_StyleScopedClasses['page-title']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "page-subtitle" },
    });
    /** @type {__VLS_StyleScopedClasses['page-subtitle']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "toolbar__actions" },
    });
    /** @type {__VLS_StyleScopedClasses['toolbar__actions']} */ ;
    let __VLS_37;
    /** @ts-ignore @type {typeof __VLS_components.elButton | typeof __VLS_components.ElButton | typeof __VLS_components.elButton | typeof __VLS_components.ElButton} */
    elButton;
    // @ts-ignore
    const __VLS_38 = __VLS_asFunctionalComponent1(__VLS_37, new __VLS_37({
        ...{ 'onClick': {} },
        type: "danger",
        plain: true,
        disabled: (__VLS_ctx.invalidFiles.length === 0),
        loading: (__VLS_ctx.cleaningInvalid),
    }));
    const __VLS_39 = __VLS_38({
        ...{ 'onClick': {} },
        type: "danger",
        plain: true,
        disabled: (__VLS_ctx.invalidFiles.length === 0),
        loading: (__VLS_ctx.cleaningInvalid),
    }, ...__VLS_functionalComponentArgsRest(__VLS_38));
    let __VLS_42;
    const __VLS_43 = ({ click: {} },
        { onClick: (__VLS_ctx.cleanAllInvalid) });
    const { default: __VLS_44 } = __VLS_40.slots;
    (__VLS_ctx.invalidFiles.length);
    // @ts-ignore
    [invalidFiles, invalidFiles, cleaningInvalid, cleanAllInvalid,];
    var __VLS_40;
    var __VLS_41;
    let __VLS_45;
    /** @ts-ignore @type {typeof __VLS_components.elButton | typeof __VLS_components.ElButton | typeof __VLS_components.elButton | typeof __VLS_components.ElButton} */
    elButton;
    // @ts-ignore
    const __VLS_46 = __VLS_asFunctionalComponent1(__VLS_45, new __VLS_45({
        ...{ 'onClick': {} },
        loading: (__VLS_ctx.loading),
    }));
    const __VLS_47 = __VLS_46({
        ...{ 'onClick': {} },
        loading: (__VLS_ctx.loading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_46));
    let __VLS_50;
    const __VLS_51 = ({ click: {} },
        { onClick: (__VLS_ctx.loadFiles) });
    const { default: __VLS_52 } = __VLS_48.slots;
    // @ts-ignore
    [loading, loadFiles,];
    var __VLS_48;
    var __VLS_49;
    // @ts-ignore
    [];
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "filters" },
});
/** @type {__VLS_StyleScopedClasses['filters']} */ ;
let __VLS_53;
/** @ts-ignore @type {typeof __VLS_components.elInput | typeof __VLS_components.ElInput} */
elInput;
// @ts-ignore
const __VLS_54 = __VLS_asFunctionalComponent1(__VLS_53, new __VLS_53({
    modelValue: (__VLS_ctx.searchText),
    clearable: true,
    placeholder: "搜索邮箱 / 账号",
}));
const __VLS_55 = __VLS_54({
    modelValue: (__VLS_ctx.searchText),
    clearable: true,
    placeholder: "搜索邮箱 / 账号",
}, ...__VLS_functionalComponentArgsRest(__VLS_54));
let __VLS_58;
/** @ts-ignore @type {typeof __VLS_components.elSelect | typeof __VLS_components.ElSelect | typeof __VLS_components.elSelect | typeof __VLS_components.ElSelect} */
elSelect;
// @ts-ignore
const __VLS_59 = __VLS_asFunctionalComponent1(__VLS_58, new __VLS_58({
    modelValue: (__VLS_ctx.filterStatus),
    clearable: true,
    placeholder: "全部状态",
}));
const __VLS_60 = __VLS_59({
    modelValue: (__VLS_ctx.filterStatus),
    clearable: true,
    placeholder: "全部状态",
}, ...__VLS_functionalComponentArgsRest(__VLS_59));
const { default: __VLS_63 } = __VLS_61.slots;
let __VLS_64;
/** @ts-ignore @type {typeof __VLS_components.elOption | typeof __VLS_components.ElOption} */
elOption;
// @ts-ignore
const __VLS_65 = __VLS_asFunctionalComponent1(__VLS_64, new __VLS_64({
    label: "有效",
    value: "active",
}));
const __VLS_66 = __VLS_65({
    label: "有效",
    value: "active",
}, ...__VLS_functionalComponentArgsRest(__VLS_65));
let __VLS_69;
/** @ts-ignore @type {typeof __VLS_components.elOption | typeof __VLS_components.ElOption} */
elOption;
// @ts-ignore
const __VLS_70 = __VLS_asFunctionalComponent1(__VLS_69, new __VLS_69({
    label: "禁用",
    value: "disabled",
}));
const __VLS_71 = __VLS_70({
    label: "禁用",
    value: "disabled",
}, ...__VLS_functionalComponentArgsRest(__VLS_70));
let __VLS_74;
/** @ts-ignore @type {typeof __VLS_components.elOption | typeof __VLS_components.ElOption} */
elOption;
// @ts-ignore
const __VLS_75 = __VLS_asFunctionalComponent1(__VLS_74, new __VLS_74({
    label: "限额中",
    value: "usage_limited",
}));
const __VLS_76 = __VLS_75({
    label: "限额中",
    value: "usage_limited",
}, ...__VLS_functionalComponentArgsRest(__VLS_75));
let __VLS_79;
/** @ts-ignore @type {typeof __VLS_components.elOption | typeof __VLS_components.ElOption} */
elOption;
// @ts-ignore
const __VLS_80 = __VLS_asFunctionalComponent1(__VLS_79, new __VLS_79({
    label: "Token 失效",
    value: "token_invalid",
}));
const __VLS_81 = __VLS_80({
    label: "Token 失效",
    value: "token_invalid",
}, ...__VLS_functionalComponentArgsRest(__VLS_80));
// @ts-ignore
[searchText, filterStatus,];
var __VLS_61;
let __VLS_84;
/** @ts-ignore @type {typeof __VLS_components.elTable | typeof __VLS_components.ElTable | typeof __VLS_components.elTable | typeof __VLS_components.ElTable} */
elTable;
// @ts-ignore
const __VLS_85 = __VLS_asFunctionalComponent1(__VLS_84, new __VLS_84({
    data: (__VLS_ctx.filteredFiles),
    rowKey: "id",
    stripe: true,
    emptyText: "暂无线上账号数据",
}));
const __VLS_86 = __VLS_85({
    data: (__VLS_ctx.filteredFiles),
    rowKey: "id",
    stripe: true,
    emptyText: "暂无线上账号数据",
}, ...__VLS_functionalComponentArgsRest(__VLS_85));
__VLS_asFunctionalDirective(__VLS_directives.vLoading, {})(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.loading) }, null, null);
const { default: __VLS_89 } = __VLS_87.slots;
let __VLS_90;
/** @ts-ignore @type {typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn} */
elTableColumn;
// @ts-ignore
const __VLS_91 = __VLS_asFunctionalComponent1(__VLS_90, new __VLS_90({
    prop: "account",
    label: "邮箱",
    minWidth: "240",
}));
const __VLS_92 = __VLS_91({
    prop: "account",
    label: "邮箱",
    minWidth: "240",
}, ...__VLS_functionalComponentArgsRest(__VLS_91));
let __VLS_95;
/** @ts-ignore @type {typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn | typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn} */
elTableColumn;
// @ts-ignore
const __VLS_96 = __VLS_asFunctionalComponent1(__VLS_95, new __VLS_95({
    label: "状态",
    width: "120",
}));
const __VLS_97 = __VLS_96({
    label: "状态",
    width: "120",
}, ...__VLS_functionalComponentArgsRest(__VLS_96));
const { default: __VLS_100 } = __VLS_98.slots;
{
    const { default: __VLS_101 } = __VLS_98.slots;
    const [{ row }] = __VLS_vSlot(__VLS_101);
    let __VLS_102;
    /** @ts-ignore @type {typeof __VLS_components.elTag | typeof __VLS_components.ElTag | typeof __VLS_components.elTag | typeof __VLS_components.ElTag} */
    elTag;
    // @ts-ignore
    const __VLS_103 = __VLS_asFunctionalComponent1(__VLS_102, new __VLS_102({
        type: (__VLS_ctx.statusTagType(row)),
        effect: "light",
    }));
    const __VLS_104 = __VLS_103({
        type: (__VLS_ctx.statusTagType(row)),
        effect: "light",
    }, ...__VLS_functionalComponentArgsRest(__VLS_103));
    const { default: __VLS_107 } = __VLS_105.slots;
    (__VLS_ctx.statusLabel(row));
    // @ts-ignore
    [loading, filteredFiles, vLoading, statusTagType, statusLabel,];
    var __VLS_105;
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_98;
let __VLS_108;
/** @ts-ignore @type {typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn | typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn} */
elTableColumn;
// @ts-ignore
const __VLS_109 = __VLS_asFunctionalComponent1(__VLS_108, new __VLS_108({
    label: "限额状态",
    width: "120",
}));
const __VLS_110 = __VLS_109({
    label: "限额状态",
    width: "120",
}, ...__VLS_functionalComponentArgsRest(__VLS_109));
const { default: __VLS_113 } = __VLS_111.slots;
{
    const { default: __VLS_114 } = __VLS_111.slots;
    const [{ row }] = __VLS_vSlot(__VLS_114);
    if (__VLS_ctx.usageLimitState(row) === 'limited') {
        let __VLS_115;
        /** @ts-ignore @type {typeof __VLS_components.elTag | typeof __VLS_components.ElTag | typeof __VLS_components.elTag | typeof __VLS_components.ElTag} */
        elTag;
        // @ts-ignore
        const __VLS_116 = __VLS_asFunctionalComponent1(__VLS_115, new __VLS_115({
            type: "warning",
            effect: "plain",
        }));
        const __VLS_117 = __VLS_116({
            type: "warning",
            effect: "plain",
        }, ...__VLS_functionalComponentArgsRest(__VLS_116));
        const { default: __VLS_120 } = __VLS_118.slots;
        // @ts-ignore
        [usageLimitState,];
        var __VLS_118;
    }
    else if (__VLS_ctx.usageLimitState(row) === 'recoverable') {
        let __VLS_121;
        /** @ts-ignore @type {typeof __VLS_components.elTag | typeof __VLS_components.ElTag | typeof __VLS_components.elTag | typeof __VLS_components.ElTag} */
        elTag;
        // @ts-ignore
        const __VLS_122 = __VLS_asFunctionalComponent1(__VLS_121, new __VLS_121({
            type: "info",
            effect: "plain",
        }));
        const __VLS_123 = __VLS_122({
            type: "info",
            effect: "plain",
        }, ...__VLS_functionalComponentArgsRest(__VLS_122));
        const { default: __VLS_126 } = __VLS_124.slots;
        // @ts-ignore
        [usageLimitState,];
        var __VLS_124;
    }
    else if (__VLS_ctx.usageLimitState(row) === 'recovered') {
        let __VLS_127;
        /** @ts-ignore @type {typeof __VLS_components.elTag | typeof __VLS_components.ElTag | typeof __VLS_components.elTag | typeof __VLS_components.ElTag} */
        elTag;
        // @ts-ignore
        const __VLS_128 = __VLS_asFunctionalComponent1(__VLS_127, new __VLS_127({
            type: "success",
            effect: "plain",
        }));
        const __VLS_129 = __VLS_128({
            type: "success",
            effect: "plain",
        }, ...__VLS_functionalComponentArgsRest(__VLS_128));
        const { default: __VLS_132 } = __VLS_130.slots;
        // @ts-ignore
        [usageLimitState,];
        var __VLS_130;
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    }
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_111;
let __VLS_133;
/** @ts-ignore @type {typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn | typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn} */
elTableColumn;
// @ts-ignore
const __VLS_134 = __VLS_asFunctionalComponent1(__VLS_133, new __VLS_133({
    label: "Token 状态",
    width: "140",
}));
const __VLS_135 = __VLS_134({
    label: "Token 状态",
    width: "140",
}, ...__VLS_functionalComponentArgsRest(__VLS_134));
const { default: __VLS_138 } = __VLS_136.slots;
{
    const { default: __VLS_139 } = __VLS_136.slots;
    const [{ row }] = __VLS_vSlot(__VLS_139);
    if (__VLS_ctx.isTokenInvalid(row)) {
        let __VLS_140;
        /** @ts-ignore @type {typeof __VLS_components.elTag | typeof __VLS_components.ElTag | typeof __VLS_components.elTag | typeof __VLS_components.ElTag} */
        elTag;
        // @ts-ignore
        const __VLS_141 = __VLS_asFunctionalComponent1(__VLS_140, new __VLS_140({
            type: "danger",
            effect: "plain",
        }));
        const __VLS_142 = __VLS_141({
            type: "danger",
            effect: "plain",
        }, ...__VLS_functionalComponentArgsRest(__VLS_141));
        const { default: __VLS_145 } = __VLS_143.slots;
        // @ts-ignore
        [isTokenInvalid,];
        var __VLS_143;
    }
    else {
        let __VLS_146;
        /** @ts-ignore @type {typeof __VLS_components.elTag | typeof __VLS_components.ElTag | typeof __VLS_components.elTag | typeof __VLS_components.ElTag} */
        elTag;
        // @ts-ignore
        const __VLS_147 = __VLS_asFunctionalComponent1(__VLS_146, new __VLS_146({
            type: "success",
            effect: "plain",
        }));
        const __VLS_148 = __VLS_147({
            type: "success",
            effect: "plain",
        }, ...__VLS_functionalComponentArgsRest(__VLS_147));
        const { default: __VLS_151 } = __VLS_149.slots;
        // @ts-ignore
        [];
        var __VLS_149;
    }
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_136;
let __VLS_152;
/** @ts-ignore @type {typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn | typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn} */
elTableColumn;
// @ts-ignore
const __VLS_153 = __VLS_asFunctionalComponent1(__VLS_152, new __VLS_152({
    label: "套餐",
    width: "100",
}));
const __VLS_154 = __VLS_153({
    label: "套餐",
    width: "100",
}, ...__VLS_functionalComponentArgsRest(__VLS_153));
const { default: __VLS_157 } = __VLS_155.slots;
{
    const { default: __VLS_158 } = __VLS_155.slots;
    const [{ row }] = __VLS_vSlot(__VLS_158);
    (row.id_token?.plan_type || '-');
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_155;
let __VLS_159;
/** @ts-ignore @type {typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn | typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn} */
elTableColumn;
// @ts-ignore
const __VLS_160 = __VLS_asFunctionalComponent1(__VLS_159, new __VLS_159({
    label: "恢复时间",
    minWidth: "180",
}));
const __VLS_161 = __VLS_160({
    label: "恢复时间",
    minWidth: "180",
}, ...__VLS_functionalComponentArgsRest(__VLS_160));
const { default: __VLS_164 } = __VLS_162.slots;
{
    const { default: __VLS_165 } = __VLS_162.slots;
    const [{ row }] = __VLS_vSlot(__VLS_165);
    (__VLS_ctx.formatRecoveryTime(row));
    // @ts-ignore
    [formatRecoveryTime,];
}
// @ts-ignore
[];
var __VLS_162;
let __VLS_166;
/** @ts-ignore @type {typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn | typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn} */
elTableColumn;
// @ts-ignore
const __VLS_167 = __VLS_asFunctionalComponent1(__VLS_166, new __VLS_166({
    label: "创建时间",
    minWidth: "180",
}));
const __VLS_168 = __VLS_167({
    label: "创建时间",
    minWidth: "180",
}, ...__VLS_functionalComponentArgsRest(__VLS_167));
const { default: __VLS_171 } = __VLS_169.slots;
{
    const { default: __VLS_172 } = __VLS_169.slots;
    const [{ row }] = __VLS_vSlot(__VLS_172);
    (__VLS_ctx.formatDate(row.created_at));
    // @ts-ignore
    [formatDate,];
}
// @ts-ignore
[];
var __VLS_169;
let __VLS_173;
/** @ts-ignore @type {typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn | typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn} */
elTableColumn;
// @ts-ignore
const __VLS_174 = __VLS_asFunctionalComponent1(__VLS_173, new __VLS_173({
    label: "最后刷新",
    minWidth: "180",
}));
const __VLS_175 = __VLS_174({
    label: "最后刷新",
    minWidth: "180",
}, ...__VLS_functionalComponentArgsRest(__VLS_174));
const { default: __VLS_178 } = __VLS_176.slots;
{
    const { default: __VLS_179 } = __VLS_176.slots;
    const [{ row }] = __VLS_vSlot(__VLS_179);
    (__VLS_ctx.formatDate(row.last_refresh));
    // @ts-ignore
    [formatDate,];
}
// @ts-ignore
[];
var __VLS_176;
let __VLS_180;
/** @ts-ignore @type {typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn | typeof __VLS_components.elTableColumn | typeof __VLS_components.ElTableColumn} */
elTableColumn;
// @ts-ignore
const __VLS_181 = __VLS_asFunctionalComponent1(__VLS_180, new __VLS_180({
    label: "操作",
    width: "120",
    fixed: "right",
}));
const __VLS_182 = __VLS_181({
    label: "操作",
    width: "120",
    fixed: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_181));
const { default: __VLS_185 } = __VLS_183.slots;
{
    const { default: __VLS_186 } = __VLS_183.slots;
    const [{ row }] = __VLS_vSlot(__VLS_186);
    let __VLS_187;
    /** @ts-ignore @type {typeof __VLS_components.elButton | typeof __VLS_components.ElButton | typeof __VLS_components.elButton | typeof __VLS_components.ElButton} */
    elButton;
    // @ts-ignore
    const __VLS_188 = __VLS_asFunctionalComponent1(__VLS_187, new __VLS_187({
        ...{ 'onClick': {} },
        link: true,
        type: "danger",
        loading: (__VLS_ctx.deletingId === row.id),
    }));
    const __VLS_189 = __VLS_188({
        ...{ 'onClick': {} },
        link: true,
        type: "danger",
        loading: (__VLS_ctx.deletingId === row.id),
    }, ...__VLS_functionalComponentArgsRest(__VLS_188));
    let __VLS_192;
    const __VLS_193 = ({ click: {} },
        { onClick: (...[$event]) => {
                __VLS_ctx.deleteFile(row);
                // @ts-ignore
                [deletingId, deleteFile,];
            } });
    const { default: __VLS_194 } = __VLS_190.slots;
    // @ts-ignore
    [];
    var __VLS_190;
    var __VLS_191;
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_183;
// @ts-ignore
[];
var __VLS_87;
// @ts-ignore
[];
var __VLS_33;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
