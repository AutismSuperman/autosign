import type { Account, Site } from '../../shared/types'
import { authHeaders, parseJson, send, wafBlocked } from '../net/httpClient'
import { mergeSetCookies } from '../net/waf'
import { kindOf, selfPaths } from './profile'

/**
 * 会话自愈。
 *
 * 桌面端长期运行会遇到三类会话问题，处理方式完全不同：
 *
 *   1. 短期令牌过期（5xx 之外的 401，且站点是 New API 系）
 *      → 用已有 refresh cookie 调 /api/user/auth/refresh，不重新 OAuth
 *   2. 会话被杀（409 AUTH_SESSION_LIMIT / 明确的未登录）
 *      → 立即停止，不重试；引导用户去站点端退出多余设备
 *   3. 瞬时 WAF 抖动（503 / 质询页）
 *      → 对幂等 GET 廉价重试，最多两次；不要因为一次抖动就判会话死亡
 *
 * 并发约束：同一账号的续期必须串行并共享结果。否则两个请求同时拿到 401，
 * 会各自用同一个 refresh cookie 换一次，第二次可能因 cookie 已轮换而失败，
 * 甚至把账号踢下线。
 */

/** 每个账号一把锁；同一账号的续期请求在这里排队。 */
const refreshLocks = new Map<string, Promise<string>>()

export interface SessionDeps {
  proxy: string
  /** 续期成功后回写账号（token 与轮换后的 cookie）。 */
  onRenewed: (accountId: string, patch: { token?: string; cookie?: string }) => Promise<void>
  /** 读最新账号状态（续期可能已被其他并发请求更新）。 */
  readAccount: (accountId: string) => Account | undefined
  log: (level: 'info' | 'ok' | 'warn' | 'err', message: string, detail?: string) => void
}

/** JWT 是否已过期或即将过期（提前 2 分钟视为需要续期）。 */
export function needsRefresh(token: string | undefined): boolean {
  if (!token) return true
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: number
    }
    if (typeof payload.exp !== 'number') return false
    const remainMs = payload.exp * 1000 - Date.now()
    return remainMs < 2 * 60_000
  } catch {
    return false
  }
}

function hasRefreshCookie(cookie: string | undefined): boolean {
  if (!cookie) return false
  return /(?:^|;\s*)(?:session|refresh_token|token)=/i.test(cookie)
}

/**
 * 用 refresh cookie 续期短期令牌。
 *
 * @param force 由 401 触发时为 true。此时无论 JWT 看起来是否过期都必须续期：
 *              服务端已明确拒绝该 token（可能被吊销、密钥轮换，或本就不是 JWT），
 *              只能靠 refresh cookie 换新的。
 *
 * 已续期过则直接复用结果：并发请求不应各自消费同一个 refresh cookie。
 */
export async function renewToken(
  site: Site,
  account: Account,
  deps: SessionDeps,
  force = false
): Promise<string> {
  const pending = refreshLocks.get(account.id)
  if (pending) return pending

  const task = (async (): Promise<string> => {
    // 进入临界区后重新读账号：可能已被上一个持锁者更新
    const fresh = deps.readAccount(account.id) ?? account
    // 401 已证明当前 token 不可用；非强制场景才按 JWT 有效期提前续
    if (!force && fresh.token && !needsRefresh(fresh.token)) return fresh.token
    if (!hasRefreshCookie(fresh.cookie)) return ''

    const base = site.baseUrl.replace(/\/+$/, '')
    deps.log('info', '开始续期短期令牌')

    try {
      const res = await send(`${base}/api/user/auth/refresh`, {
        method: 'POST',
        headers: {
          ...authHeaders(fresh.token, fresh.siteUserId),
          'Content-Type': 'application/json',
          Origin: base,
          Referer: `${base}/`,
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: '{}',
        proxy: deps.proxy,
        cookie: fresh.cookie,
        timeoutMs: 20_000
      })

      const json = parseJson<{ success?: boolean; data?: { access_token?: string } }>(res.body)
      const newToken =
        typeof json?.data?.access_token === 'string' ? json.data.access_token : ''

      // refresh 会轮换 cookie，必须把新值一起落库，否则下次续期用旧值必然失败
      const rotatedCookie = mergeSetCookies(fresh.cookie, res.setCookies)
      const cookieChanged = rotatedCookie !== fresh.cookie

      if (res.status !== 200 || json?.success !== true || !newToken) {
        deps.log(
          'warn',
          '续期未成功',
          `HTTP ${res.status}；token=${!!newToken}；cookieRotated=${cookieChanged}`
        )
        // 即使没拿到 token，轮换后的 cookie 也要保存，否则会话彻底断掉
        if (cookieChanged) await deps.onRenewed(account.id, { cookie: rotatedCookie })
        return ''
      }

      await deps.onRenewed(account.id, { token: newToken, cookie: rotatedCookie })
      deps.log('ok', '短期令牌已续期', `cookieRotated=${cookieChanged}`)
      return newToken
    } catch (e) {
      deps.log('warn', '续期异常', e instanceof Error ? e.message : String(e))
      return ''
    } finally {
      refreshLocks.delete(account.id)
    }
  })()

  refreshLocks.set(account.id, task)
  return task
}

/** 会话数超限：服务端明确拒绝建新会话，此时重试只会再撞一次。 */
export function isSessionLimit(status: number, body: string): boolean {
  if (status === 409) return true
  return /AUTH_SESSION_LIMIT/i.test(body)
}

/** 是否是「会话确实失效」的信号（区别于瞬时抖动与限流）。 */
export function isSessionDead(status: number, body: string): boolean {
  if (status === 401) return !wafBlocked(body)
  if (status === 403) return true
  return /未登录|请先登录|AUTH_TOKEN|unauthorized/i.test(body)
}

/** 是否只是瞬时抖动，值得原样重试。 */
export function isTransient(status: number, body: string): boolean {
  if (status === 503 || status === 502 || status === 504) return true
  return wafBlocked(body)
}

/**
 * 带自愈的业务请求。
 *
 * 流程：原生请求 → 瞬时抖动重试 → 401 时续期后重试一次 → 仍失败则如实返回。
 * 只有幂等 GET 做抖动重试；POST 签到绝不重放，避免重复签到或重复扣费。
 */
export async function requestWithHealing(
  site: Site,
  account: Account,
  method: string,
  path: string,
  deps: SessionDeps,
  body?: string
): Promise<{ status: number; body: string; setCookies: string[]; token: string }> {
  const base = site.baseUrl.replace(/\/+$/, '')
  const idempotent = method.toUpperCase() === 'GET'
  let current = account
  let token = current.token ?? ''
  let last = { status: 0, body: '', setCookies: [] as string[] }

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await send(`${base}${path}`, {
      method,
      headers: { ...authHeaders(token, current.siteUserId), 'Content-Type': 'application/json' },
      body,
      proxy: deps.proxy,
      cookie: current.cookie,
      timeoutMs: 20_000
    })
    last = { status: res.status, body: res.body, setCookies: res.setCookies }

    if (isSessionLimit(res.status, res.body)) {
      deps.log('err', '站点会话数已达上限', '已立即停止，不重试')
      return { ...last, token }
    }

    // 成功或确定性业务失败（404 等）：直接返回，不折腾会话
    if (res.status === 200 || (!isSessionDead(res.status, res.body) && !isTransient(res.status, res.body))) {
      return { ...last, token }
    }

    if (isTransient(res.status, res.body) && idempotent && attempt < 2) {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
      continue
    }

    if (isSessionDead(res.status, res.body)) {
      // 只对 NEWAPI 系尝试续期；其它形态没有 refresh 端点
      if (kindOf(site) !== 'NEWAPI') {
        deps.log('warn', '会话已失效，该站点不支持静默续期')
        return { ...last, token }
      }
      const renewed = await renewToken(site, current, deps, true)
      if (!renewed || renewed === token) {
        deps.log('warn', '会话已失效且无法续期')
        return { ...last, token }
      }
      // 续期成功：用新 token 与新 cookie 重试一次
      token = renewed
      current = deps.readAccount(account.id) ?? current
      continue
    }

    return { ...last, token }
  }

  return { ...last, token }
}

/** 读额度（带自愈）。找不到可用端点时返回明确原因。 */
export async function readSelfWithHealing(
  site: Site,
  account: Account,
  deps: SessionDeps
): Promise<{ status: number; body: string; token: string; path: string }> {
  const kind = kindOf(site)
  const paths = selfPaths(kind, site.baseUrl)
  let last = { status: 0, body: '', token: account.token ?? '', path: paths[0] ?? '' }
  for (const path of paths) {
    const r = await requestWithHealing(site, account, 'GET', path, deps)
    last = { status: r.status, body: r.body, token: r.token, path }
    if (r.status !== 404 && r.status !== 405) return last
  }
  return last
}
