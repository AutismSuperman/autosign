import type { Account, Site } from '../../shared/types'
import { authHeaders, parseJson, send } from '../net/httpClient'
import { isAnyRouter, kindOf } from './profile'
import { needsRefresh, renewToken } from './session'
import type { SessionDeps } from './session'

/**
 * 站点登出。
 *
 * 为什么登出前要先续期：token 通常 15 分钟过期，直接带过期 token 调 logout
 * 会被判 401，看起来像「已登出」而实际会话还活着 —— 上游在 just 站踩过这个坑，
 * 表现为会话卡死、重登领不到奖。
 *
 * 因此在登出前确保凭据是服务端当下认得的有效值。
 */

export type LogoutState = 'confirmed' | 'absent' | 'denied' | 'unconfirmed'

export interface LogoutDeps {
  proxy: string
  session: SessionDeps
  log: (level: 'info' | 'ok' | 'warn' | 'err', message: string, detail?: string) => void
}

export async function logoutSession(
  site: Site,
  account: Account,
  deps: LogoutDeps
): Promise<{ state: LogoutState; cookie?: string }> {
  const base = site.baseUrl.replace(/\/+$/, '')
  let token = account.token ?? ''
  let cookie = account.cookie
  let siteUserId = account.siteUserId

  if (!token && !cookie) return { state: 'absent' }

  // 1) 登出前续期：确保服务端认得这份凭据
  if (needsRefresh(token) && cookie) {
    const renewed = await renewToken(site, account, deps.session, true)
    if (renewed) {
      token = renewed
      const fresh = deps.session.readAccount(account.id)
      if (fresh) {
        cookie = fresh.cookie
        siteUserId = fresh.siteUserId
      }
      deps.log('info', '登出前已续期令牌')
    }
  } else if (!token && cookie && kindOf(site) === 'NEWAPI') {
    // 无 token 的 session-cookie 站：self 响应体自带 access_token，可作为 Bearer 使用
    try {
      const r = await send(`${base}/api/user/self`, {
        proxy: deps.proxy,
        cookie,
        headers: authHeaders('', siteUserId),
        timeoutMs: 15_000
      })
      const json = parseJson<{ data?: { access_token?: string } }>(r.body)
      if (typeof json?.data?.access_token === 'string') {
        token = json.data.access_token
        deps.log('info', '已从 self 取得可用令牌')
      }
    } catch {
      // 取不到就继续，登出仍可能成功
    }
  }

  // 2) 主通道：GET /api/user/logout
  try {
    const res = await send(`${base}/api/user/logout`, {
      method: 'GET',
      headers: authHeaders(token, siteUserId),
      proxy: deps.proxy,
      cookie,
      timeoutMs: 20_000
    })
    const json = parseJson<{ success?: boolean; message?: string }>(res.body)
    deps.log('info', '登出通道响应', `HTTP ${res.status}；json=${!!json}`)

    if (res.status === 200 && json?.success !== false) {
      return { state: 'confirmed', cookie }
    }
    if (res.status === 401 && /无|不存在|not.?found/i.test(json?.message ?? '')) {
      return { state: 'absent', cookie }
    }
    if (json && json.success === false && /拒绝|denied|forbidden/i.test(json.message ?? '')) {
      return { state: 'denied', cookie }
    }
  } catch (e) {
    deps.log('warn', '登出请求异常', e instanceof Error ? e.message : String(e))
  }

  // 3) 复核：用 self 判断会话是否真的没了
  try {
    const check = await send(`${base}/api/user/self`, {
      proxy: deps.proxy,
      cookie,
      headers: authHeaders(token, siteUserId),
      timeoutMs: 15_000
    })
    if (check.status === 401 || check.status === 403) {
      return { state: 'absent', cookie }
    }
  } catch {
    // 复核失败时保持 unconfirmed，交由调用方决定
  }

  void isAnyRouter
  return { state: 'unconfirmed', cookie }
}
