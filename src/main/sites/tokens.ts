import type { Account, ApiKey, Site } from '../../shared/types'
import { parseJson } from '../net/httpClient'
import { requestWithHealing } from './session'
import type { SessionDeps } from './session'

/**
 * 读取账号在站点上的 API Key 列表。
 *
 * New API 系的端点是 `GET /api/token/?p=1&size=100`，返回结构有几种变体，
 * 上游为此做过兼容（data.items / data 是数组 / data.data.items）。
 *
 * 只读：不做新建、删除、修改，也绝不把完整 key 写进日志。
 * 这里必须走 requestWithHealing：token 只有 15 分钟有效期，
 * 直接请求很容易 401，自愈通道会先续期再重试。
 */

/** 从各种嵌套形态里取出条目数组。 */
export function pickTokenItems(payload: unknown): Record<string, unknown>[] {
  const root = payload as Record<string, unknown> | null
  if (!root || root.success === false) return []
  const data = root.data
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    // 标准 New API：data.items；部分部署把 items 再包一层 data 里
    const direct = d.items ?? d.records
    if (Array.isArray(direct)) return direct as Record<string, unknown>[]
    const nested = d.data
    if (Array.isArray(nested)) return nested as Record<string, unknown>[]
    if (nested && typeof nested === 'object') {
      const nd = nested as Record<string, unknown>
      const inner = nd.items ?? nd.records
      if (Array.isArray(inner)) return inner as Record<string, unknown>[]
    }
  }
  if (Array.isArray(root.items)) return root.items as Record<string, unknown>[]
  return []
}

/**
 * 把站点条目转成界面用的 ApiKey。
 *
 * 字段兼容：New API 的 key 字段通常是脱敏的（sk-xxxx****xxxx），
 * 只有新建时返回完整值。这里原样展示站点给了什么，不猜、不拼接。
 */
export function normalizeToken(raw: Record<string, unknown>, index: number): ApiKey {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v ? v : undefined
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const bool = (v: unknown): boolean => v === true || v === 1

  return {
    id: String(raw.id ?? raw.token_id ?? index),
    name: str(raw.name) ?? `Key ${index + 1}`,
    // 站点的 key 一般已脱敏；没有就显示占位，不编造
    key: str(raw.key) ?? '',
    group: str(raw.group) ?? '',
    userId: num(raw.user_id),
    status: bool(raw.status),
    unlimitedQuota: bool(raw.unlimited_quota),
    remainQuota: num(raw.remain_quota),
    usedQuota: num(raw.used_quota),
    expiredTime: num(raw.expired_time),
    createdTime: num(raw.created_time),
    accessedTime: num(raw.accessed_time)
  }
}

export interface ApiKeyListResult {
  ok: boolean
  keys: ApiKey[]
  error?: string
  /** 解析不到条目时的响应结构摘要，仅用于诊断。 */
  debugShape?: string
}

/**
 * 拉取某个账号的 Key 列表。
 *
 * @param size 单页条数，默认 100（与上游一致）
 */
export async function readApiKeys(
  site: Site,
  account: Account,
  deps: SessionDeps,
  size = 100
): Promise<ApiKeyListResult> {
  const paths = [
    `/api/token/?p=1&size=${size}`,
    `/api/token?p=1&size=${size}`,
    `/api/token/?p=0&size=${size}`
  ]

  let lastError = ''
  for (const path of paths) {
    try {
      const res = await requestWithHealing(site, account, 'GET', path, deps)
      if (res.status === 404 || res.status === 405) continue
      if (res.status === 401 || res.status === 403) {
        lastError = '会话已失效，无法读取 Key 列表'
        continue
      }
      if (res.status !== 200) {
        lastError = `站点返回 HTTP ${res.status}`
        continue
      }
      const json = parseJson<Record<string, unknown>>(res.body)
      if (!json) {
        lastError = '响应无法解析'
        continue
      }
      if (json.success === false) {
        lastError =
          (typeof json.message === 'string' && json.message) || '站点返回 success=false'
        continue
      }
      const items = pickTokenItems(json)
      // 只在完全取不到条目时附带响应结构摘要，便于排查而不用猜
      if (items.length === 0) {
        const shape =
          json && typeof json === 'object'
            ? JSON.stringify(Object.keys(json)) +
              ' data=' +
              (Array.isArray(json.data)
                ? `array[${(json.data as unknown[]).length}]`
                : typeof json.data === 'string'
                  ? `string(${(json.data as string).length})`
                  : json.data && typeof json.data === 'object'
                    ? `object{${Object.keys(json.data as object).join(',')}}`
                    : String(json.data))
            : 'non-object'
        return { ok: true, keys: [], debugShape: shape }
      }
      return { ok: true, keys: items.map((it, i) => normalizeToken(it, i)) }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: false, keys: [], error: lastError || '站点未提供 Key 列表接口' }
}
