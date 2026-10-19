import { BrowserWindow, session } from 'electron'
import type { Account, Site } from '../../shared/types'
import {
  githubAuthorizeScript,
  githubLoginScript,
  linuxdoApproveScript,
  linuxdoLoginScript
} from '../auth/fill'
import { totp } from '../auth/totp'
import { accountPartition } from './partition'
import type { ReloginAttempt } from './reloginSession'

/**
 * 静默重授权：会话过期时，用账号分区里已有的第三方登录态自动重建会话。
 *
 * 目标「登录一次之后就不用再管」：OAuth 只要成功过一次，GitHub / Linux DO
 * 的登录 Cookie 就留在了账号自己的分区里。之后站点会话过期，重走一遍
 * 授权流程是**不需要用户输入密码**的 —— 第三方站点认得那个 Cookie，
 * 直接把授权页显示出来、点一下「Authorize」就换到新会话。
 *
 * 与 runOAuth 的区别：
 *   - 全程 `show: false`，不打扰用户
 *   - 只在分区里确实还有第三方登录态时才可能成功
 *   - 需要用户手动输入密码 / 过人机验证时，立即放弃并返回原因，
 *     由界面提供「重新授权」按钮交给用户处理
 */

export interface SilentReauthDeps {
  proxy: string
  /** 凭据里的 TOTP 密钥（可选），GitHub 两步验证时用。 */
  findTotpSecret?: () => string | undefined
  timeoutMs?: number
}

/** 从分区 cookie 里判断是否还留着第三方登录态。 */
async function hasProviderSession(site: Site, account: Account): Promise<boolean> {
  const ses = session.fromPartition(accountPartition(site.id, account.id))
  try {
    const list = await ses.cookies.get({})
    return list.some((c) => {
      const domain = (c.domain ?? '').toLowerCase()
      if (!/github\.com|linux\.do/.test(domain)) return false
      // user_session 是 GitHub 登录态；_t 是 Discourse 的会话键
      return /^(user_session|_t|_forum_session)$/i.test(c.name) && !!c.value
    })
  } catch {
    return false
  }
}

/** 用分区 fetch 取 state 与 client_id（与 runOAuth 保持一致的行为）。 */
async function fetchSeedWith(
  base: string,
  ses: Electron.Session,
  provider: string
): Promise<{ state: string; clientId: string } | { error: string }> {
  const body = JSON.stringify({ provider, intent: 'login' })
  try {
    const res = await ses.fetch(`${base}/api/oauth/state`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body
    })
    const text = await res.text()
    let state = ''
    try {
      const j = JSON.parse(text) as { success?: boolean; data?: unknown }
      const d = j.data
      if (typeof d === 'string') state = d
      else if (d && typeof d === 'object') {
        const obj = d as Record<string, unknown>
        state = (obj.flow_token as string) || (obj.state as string) || ''
      }
    } catch {
      return { error: '站点返回了非 JSON 响应（可能被 WAF 拦截）' }
    }
    if (!state) return { error: '站点未返回授权 state' }

    const sr = await ses.fetch(`${base}/api/status`, { headers: { Accept: 'application/json' } })
    const sj = JSON.parse(await sr.text()) as { data?: Record<string, unknown> }
    const clientId = (sj.data?.[`${provider}_client_id`] as string) || ''
    if (!clientId) return { error: `站点未公开 ${provider} 的 client_id` }
    return { state, clientId }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 尝试静默重建会话。
 *
 * 成功返回新的 cookie / token；失败给出原因，调用方据此决定是否提示用户手动授权。
 */
export async function silentReauth(
  site: Site,
  account: Account,
  provider: 'github' | 'linuxdo',
  deps: SilentReauthDeps
): Promise<ReloginAttempt> {
  // 分区里没有第三方登录态，静默走不通——直接说清楚，别白开窗口
  if (!(await hasProviderSession(site, account))) {
    return {
      ok: false,
      error:
        provider === 'github'
          ? '分区内没有 GitHub 登录态，需要在应用内重新授权一次'
          : '分区内没有 Linux DO 登录态，需要在应用内重新授权一次'
    }
  }

  const ses = session.fromPartition(accountPartition(site.id, account.id))
  if (deps.proxy) {
    try {
      await ses.setProxy({ proxyRules: deps.proxy })
    } catch {
      // 代理设置失败仍继续，页面加载阶段会如实报错
    }
  }

  const seed = await fetchSeedWith(site.baseUrl.replace(/\/+$/, ''), ses, provider)
  if ('error' in seed) return { ok: false, error: seed.error }

  const base = site.baseUrl.replace(/\/+$/, '')
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 760,
    skipTaskbar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })

  const expectedState = seed.state
  const timeout = deps.timeoutMs ?? 45_000

  return new Promise<ReloginAttempt>((resolve) => {
    let settled = false
    let submitted = false
    const done = (r: ReloginAttempt): void => {
      if (settled) return
      settled = true
      try {
        win.destroy()
      } catch {
        // 窗口可能已被回收
      }
      resolve(r)
    }

    const timer = setTimeout(
      () => done({ ok: false, error: '静默重授权超时，请手动点「重新授权」' }),
      timeout
    )
    timer.unref?.()

    /** 授权页出现「需要密码/验证」时说明分区登录态已失效，交还用户。 */
    const run = async (): Promise<void> => {
      if (settled || win.isDestroyed()) return
      const url = win.webContents.getURL()
      if (!url) return

      try {
        const totpSecret = deps.findTotpSecret?.()
        const payload = {
          username: '',
          password: undefined,
          otp: totpSecret ? totp(totpSecret) : undefined
        }

        // 授权确认页优先
        const authScript = provider === 'linuxdo' ? linuxdoApproveScript() : githubAuthorizeScript()
        const authRaw = await win.webContents.executeJavaScript(authScript, true)
        const auth = typeof authRaw === 'string' ? JSON.parse(authRaw) : null
        if (auth?.step === 'authorized' || auth?.step === 'already-authorized') return
        if (auth?.step === 'invalid-redirect') {
          done({ ok: false, error: '站点的 OAuth 应用未登记该回调地址' })
          return
        }

        if (submitted) return

        // 落到登录表单 = 分区里的第三方登录态已失效，静默做不了
        const loginScript = provider === 'linuxdo' ? linuxdoLoginScript(payload) : githubLoginScript(payload)
        const raw = await win.webContents.executeJavaScript(loginScript, true)
        const st = typeof raw === 'string' ? JSON.parse(raw) : null
        if (st?.step === 'submitted' || st?.step === 'submitted-otp') {
          submitted = true
          return
        }
        if (st?.step === 'need-otp' || st?.step === 'manual') {
          done({
            ok: false,
            error: '第三方登录态已失效，需要手动重新授权（可能要求输入密码或人机验证）'
          })
        }
      } catch {
        // 注入失败不致命，等下一次导航再试
      }
    }

    const callback = async (url: string): Promise<void> => {
      if (settled) return
      try {
        const u = new URL(url)
        const error = u.searchParams.get('error')
        if (error) {
          done({ ok: false, error: `授权被拒绝：${error}` })
          return
        }
        const code = u.searchParams.get('code')
        const state = u.searchParams.get('state') ?? ''
        if (!code) return
        if (state !== expectedState) {
          done({ ok: false, error: '授权回调 state 不匹配，已拒绝' })
          return
        }
        // 用分区 fetch 兑换，会话 Cookie 直接落在这个分区
        const res = await ses.fetch(
          `${base}/api/oauth/${provider}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          { headers: { Accept: 'application/json' } }
        )
        const text = await res.text()
        let json: Record<string, unknown> | null = null
        try {
          json = JSON.parse(text) as Record<string, unknown>
        } catch {
          json = null
        }
        if (res.status === 409 || /AUTH_SESSION_LIMIT/i.test(text)) {
          done({ ok: false, error: '站点会话数已达上限，请到站点端退出多余设备' })
          return
        }
        if (json?.success !== true) {
          done({
            ok: false,
            error: `凭据交换失败：${(json?.message as string) || `HTTP ${res.status}`}`
          })
          return
        }
        const data = json.data as Record<string, unknown> | undefined
        const token =
          (typeof data?.access_token === 'string' && data.access_token) ||
          (typeof data?.token === 'string' && data.token) ||
          undefined
        const cookies = await ses.cookies.get({ url: base })
        const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        done({ ok: true, cookie, token })
      } catch (e) {
        done({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }

    win.webContents.on('did-finish-load', () => void run())
    win.webContents.on('did-navigate', (_e, url) => void callback(url))
    win.webContents.on('will-redirect', (_e, url) => void callback(url))
    win.on('closed', () => {
      if (!settled) {
        settled = true
        resolve({ ok: false, error: '授权窗口已关闭' })
      }
    })

    const authorizeUrl =
      provider === 'linuxdo'
        ? `https://connect.linux.do/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(
            seed.clientId
          )}&state=${encodeURIComponent(expectedState)}`
        : `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
            seed.clientId
          )}&state=${encodeURIComponent(expectedState)}&scope=read:user`

    void win.loadURL(authorizeUrl)
  })
}
