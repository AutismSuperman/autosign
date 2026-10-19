import { BrowserWindow, session } from 'electron'
import { randomBytes } from 'node:crypto'
import type { Session } from 'electron'
import type { AuthProvider, Credential, Site } from '../../shared/types'
import {
  githubAuthorizeScript,
  githubLoginScript,
  linuxdoApproveScript,
  linuxdoLoginScript
} from '../auth/fill'
import { totp } from '../auth/totp'
import { accountPartition } from './partition'

/**
 * OAuth 授权窗口。
 *
 * 与上游 Android 端流程一致：
 *   1. 向站点取 /api/oauth/state，拿到本轮 state（用于防串流/CSRF）
 *   2. 打开 GitHub 或 Linux DO 的授权页，由用户在窗口内完成登录与授权
 *   3. 拦截回调 URL，取出 code，校验 state 严格一致
 *   4. 用 code + state 调站点 /api/oauth/<provider> 换取会话 Cookie
 *
 * 每个「站点 × 账号」使用独立的持久化 partition，互不串号。
 * 仅此流程会打开可见窗口；额度刷新与签到永不触发 OAuth。
 */

export interface OAuthResult {
  ok: boolean
  cookie?: string
  token?: string
  username?: string
  siteUserId?: string
  error?: string
}

/**
 * 构造第三方授权页地址。
 *
 * **不要传 redirect_uri**：New API 在每个站点后台只登记了唯一回调地址
 * （`{site}/api/oauth/{provider}`），由站点服务端决定，客户端带什么都会被
 * GitHub / connect.linux.do 判为「未注册的重定向地址」并直接拒绝。
 * 上游 Android 端也是同样的做法：只传 client_id + state。
 */
function providerAuthorizeUrl(provider: AuthProvider, clientId: string, state: string): string {
  if (provider === 'linuxdo') {
    const u = new URL('https://connect.linux.do/oauth2/authorize')
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('client_id', clientId)
    u.searchParams.set('state', state)
    return u.toString()
  }
  const u = new URL('https://github.com/login/oauth/authorize')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('state', state)
  u.searchParams.set('scope', 'read:user')
  return u.toString()
}

/**
 * 在**账号自己的分区**内取 state 与 client_id。
 *
 * 为什么不能用主进程 httpClient：旧版 New API 把 state 存在服务端 session 里，
 * 而该 session 与浏览器的 Cookie 分区绑定。用另一套连接取 state、再到窗口里兑换，
 * 服务端会因 session 不匹配判「state 无效」——上游真机踩过这个坑。
 * 因此这里统一用分区的 fetch，保证取 state 与兑换发生在同一个 Cookie 上下文。
 *
 * 端点形态随 New API 版本而变，实测：
 *   - 新版（seekai / kktoken / justwoker / agentrouter）：POST /api/oauth/state，
 *     body 必须带 provider（缺省会返回 "Invalid parameters"），
 *     回包是 { data: { flow_token } } 或 data 直接是字符串
 *   - 部分站点只认 GET ?mode=login，未知 provider 时返回 400
 * POST 带上 provider 是正确的通用请求：新版都认，老版也接受多给的字段。
 */
async function fetchOAuthSeed(
  baseUrl: string,
  ses: Session,
  provider: AuthProvider
): Promise<{ state: string; clientId: string } | { error: string }> {
  const base = baseUrl.replace(/\/+$/, '')
  const body = JSON.stringify({ provider, intent: 'login' })
  const candidates = [
    { url: `${base}/api/oauth/state`, method: 'POST' as const },
    { url: `${base}/api/oauth/state?mode=login&provider=${provider}`, method: 'GET' as const },
    { url: `${base}/api/oauth/state?provider=${provider}`, method: 'GET' as const }
  ]

  /** New API 的 state 有两种回包：data 为字符串，或 data.flow_token。 */
  const readState = (text: string): string => {
    try {
      const json = JSON.parse(text) as {
        success?: boolean
        data?: unknown
        state?: string
        message?: string
      }
      if (json.success === false) return ''
      const data = json.data
      if (typeof data === 'string' && data) return data
      if (data && typeof data === 'object') {
        const d = data as Record<string, unknown>
        if (typeof d.flow_token === 'string' && d.flow_token) return d.flow_token
        if (typeof d.state === 'string' && d.state) return d.state
      }
      if (typeof json.state === 'string' && json.state) return json.state
    } catch {
      // 非 JSON（WAF 质询页等）：由调用方继续尝试下一个候选
    }
    return ''
  }

  let state = ''
  let lastHint = ''
  try {
    for (const c of candidates) {
      const res = await ses.fetch(c.url, {
        method: c.method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: c.method === 'POST' ? body : undefined
      })
      const text = await res.text()
      if (res.status !== 200) {
        lastHint = `HTTP ${res.status}`
        continue
      }
      state = readState(text)
      if (state) break
      // 200 但不是 JSON：多半是 WAF 质询页
      lastHint = text.trimStart().startsWith('<') ? '站点返回了人机验证页' : '响应里没有 state'
    }
  } catch (e) {
    return { error: `取授权状态失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (!state) {
    return {
      error: `站点未返回授权 state${lastHint ? `（${lastHint}）` : ''}，可稍后重试或检查代理`
    }
  }

  let clientId = ''
  try {
    const statusRes = await ses.fetch(`${base}/api/status`, { headers: { Accept: 'application/json' } })
    const json = JSON.parse(await statusRes.text()) as {
      data?: Record<string, unknown>
    }
    const d = json?.data
    // client_id 跟随 provider：anyrouter 同时下发 github / linuxdo 两个，取错会把用户送去停用的登录方式
    clientId =
      (typeof d?.[`${provider}_client_id`] === 'string' && (d[`${provider}_client_id`] as string)) || ''
    if (!clientId && provider === 'github') {
      clientId = (typeof d?.github_client_id === 'string' && d.github_client_id) || ''
    }
  } catch {
    clientId = ''
  }
  if (!clientId) return { error: `站点未公开 ${provider} 的 OAuth client_id` }
  return { state, clientId }
}

export async function runOAuth(
  site: Site,
  accountId: string,
  provider: AuthProvider | undefined,
  proxy: string,
  credential?: Credential
): Promise<OAuthResult> {
  const prov: AuthProvider = provider ?? site.provider ?? 'github'
  const base = site.baseUrl.replace(/\/+$/, '')

  // 与额度读取、签到共用同一个分区：授权得到的会话后续直接复用
  const ses = session.fromPartition(accountPartition(site.id, accountId))
  if (proxy) {
    try {
      await ses.setProxy({ proxyRules: proxy })
    } catch {
      // 代理设置失败仍继续：授权页会如实报加载失败
    }
  }

  // state 必须与兑换同一分区
  const seed = await fetchOAuthSeed(base, ses, prov)
  if ('error' in seed) return { ok: false, error: seed.error }

  const expectedState = seed.state

  const win = new BrowserWindow({
    width: 1000,
    height: 780,
    show: false,
    title: `登录 ${site.name}`,
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  return new Promise<OAuthResult>((resolve) => {
    let settled = false
    /** 本轮是否已经提交过登录表单：提交后绝不重复提交，避免触发风控。 */
    let loginSubmitted = false
    let fillAttempts = 0
    let lastFillUrl = ''
    const finish = (r: OAuthResult): void => {
      if (settled) return
      settled = true
      try {
        win.destroy()
      } catch {
        // 窗口可能已被用户关闭
      }
      resolve(r)
    }

    /**
     * 在登录页 / 授权页尝试自动化。
     *
     * 页面可能是 SPA，表单要等前端挂载后才出现，因此同一地址会重试若干轮。
     * 一旦登录已提交就不再重复，避免同一表单被连点触发风控；
     * 授权确认页的「允许」由脚本内的 sessionStorage 闸门保证只点一次。
     *
     * 没有提供凭据时也能用：已登录的 GitHub 会话会直接落到授权页，
     * 此时自动点「Authorize」同样能完成授权，不需要密码。
     */
    const tryAutofill = async (): Promise<void> => {
      if (settled) return
      const url = win.webContents.getURL()
      if (!url || /^\w+:\/\/$/.test(url)) return
      if (url === lastFillUrl && fillAttempts >= 4) return
      if (url !== lastFillUrl) {
        lastFillUrl = url
        fillAttempts = 0
      }

      fillAttempts++
      try {
        // 给前端渲染留出时间；首次进来常常还没挂载表单
        await new Promise((r) => setTimeout(r, fillAttempts === 1 ? 600 : 1200))
        if (settled || win.isDestroyed()) return

        const payload = {
          username: credential?.username ?? '',
          password: credential?.password,
          otp: credential?.totpSecret ? totp(credential.totpSecret) : undefined
        }

        // 授权确认页优先：已登录时根本不会出现登录表单
        const authorizeScript = prov === 'linuxdo' ? linuxdoApproveScript() : githubAuthorizeScript()
        const authRaw = await win.webContents.executeJavaScript(authorizeScript, true)
        const authState =
          typeof authRaw === 'string'
            ? (JSON.parse(authRaw) as { step?: string; done?: boolean; msg?: string })
            : null
        if (authState?.step === 'authorized') return
        if (authState?.step === 'already-authorized') return
        if (authState?.step === 'invalid-redirect') {
          finish({
            ok: false,
            error:
              'GitHub 拒绝了回调地址：站点后台登记的 OAuth 应用未包含该地址，请联系站点管理员，或用邮箱/密码方式登录'
          })
          return
        }

        // 登录提交后页面会跳到授权确认页：此时仍要允许授权脚本继续工作，
        // 否则「登录 → 授权」链路会在这里断掉，表现为窗口一直停着。
        if (loginSubmitted) {
          if (authState?.step === 'authorize-missing') {
            // 确实是授权页但找不到按钮（或页面还没渲染完）：再给几轮机会
            if (fillAttempts < 6) {
              await new Promise((r) => setTimeout(r, 1000))
              if (!settled && !win.isDestroyed()) await tryAutofill()
            }
          }
          return
        }

        const script = prov === 'linuxdo' ? linuxdoLoginScript(payload) : githubLoginScript(payload)
        const raw = await win.webContents.executeJavaScript(script, true)
        const state =
          typeof raw === 'string'
            ? (JSON.parse(raw) as { step?: string; done?: boolean; msg?: string })
            : null

        if (state?.step === 'manual' || state?.step === 'need-otp') {
          // 需要人工完成验证：把窗口显示出来交还用户，不再重试
          if (!win.isVisible()) win.show()
          return
        }
        if (state?.step === 'submitted' || state?.step === 'submitted-otp') {
          loginSubmitted = true
          return
        }
        if (state?.done === false && fillAttempts < 6) {
          await tryAutofill()
        }
      } catch {
        // 注入失败不影响正常手动登录
      }
    }

    const handleCallback = async (url: string): Promise<void> => {
      try {
        const u = new URL(url)
        const code = u.searchParams.get('code') ?? ''
        const state = u.searchParams.get('state') ?? ''
        const error = u.searchParams.get('error') ?? ''
        if (error) {
          finish({ ok: false, error: `授权被拒绝：${error}` })
          return
        }
        if (!code) return
        // state 必须与本轮严格一致，否则视为串流并拒绝
        if (state !== expectedState) {
          finish({ ok: false, error: '授权回调 state 不匹配，已拒绝' })
          return
        }
        const exchangeRes = await exchangeCode(base, prov, code, state, ses)
        finish(exchangeRes)
      } catch (e) {
        finish({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }

    // 页面加载完成后尝试预填（Spa 会多次导航，用去重避免重复提交）
    win.webContents.on('did-finish-load', () => {
      void tryAutofill()
    })

    win.webContents.on('will-redirect', (_e, url) => {
      void handleCallback(url)
    })
    win.webContents.on('will-navigate', (_e, url) => {
      void handleCallback(url)
    })
    win.webContents.on('did-navigate', (_e, url) => {
      void handleCallback(url)
    })

    win.on('closed', () => {
      if (!settled) {
        settled = true
        resolve({ ok: false, error: '授权窗口已关闭' })
      }
    })

    win.once('ready-to-show', () => {
      // 有保存的凭据时先不显示：填表和授权都在后台完成，用户不会看到窗口一闪。
      // 需要人工验证时由 tryAutofill 主动 show()。
      // 没有凭据就必须立刻显示，否则用户不知道要登录。
      if (!credential) win.show()
    })
    // 兜底：若长时间没有进展（例如站点改了登录页结构导致填不进去），
    // 把窗口显示出来让用户接手，避免流程静默卡死。
    if (credential) {
      setTimeout(() => {
        if (!settled && !win.isDestroyed() && !win.isVisible()) win.show()
      }, 20_000)
    }
    void win.loadURL(providerAuthorizeUrl(prov, seed.clientId, expectedState))
  })
}

/**
 * 用 code + state 调站点交换会话。
 *
 * 必须在**同一个 partition** 内发起（站点把 state 存在服务端 session，
 * 且 WAF Cookie 也在这个分区里），因此这里直接用分区内的 fetch。
 */
async function exchangeCode(
  base: string,
  provider: AuthProvider,
  code: string,
  state: string,
  ses: Session,
  expectUserId?: string
): Promise<OAuthResult> {
  const url = `${base}/api/oauth/${provider}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
  try {
    const res = await ses.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      bypassCustomProtocolHandlers: true
    })
    const body = await res.text()
    let json: Record<string, unknown> | null = null
    try {
      json = JSON.parse(body) as Record<string, unknown>
    } catch {
      json = null
    }

    // 会话数超限：服务端明确拒绝建新会话，此刻并未创建任何会话。
    // 立刻停止，且不应引导用户反复重试（重试只会再撞一次）。
    const errCode = String(json?.code ?? (json?.error as Record<string, unknown> | undefined)?.code ?? '')
    if (res.status === 409 || /AUTH_SESSION_LIMIT/i.test(errCode) || /AUTH_SESSION_LIMIT/i.test(body)) {
      return {
        ok: false,
        error: '该账号在站点的登录会话数已达上限，请到站点网页端退出多余设备后重试'
      }
    }

    // 会话 Cookie 从分区读取（New API 系登录凭据是 gin session）
    const cookies = await ses.cookies.get({ url: base })
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

    if (!res.ok || json?.success !== true) {
      const message =
        (typeof json?.message === 'string' && json.message) || `HTTP ${res.status}`
      return { ok: false, error: `凭据交换失败：${message}` }
    }

    const data = json.data as Record<string, unknown> | undefined
    const token =
      (typeof data?.access_token === 'string' && data.access_token) ||
      (typeof data?.accessToken === 'string' && data.accessToken) ||
      (typeof data?.token === 'string' && data.token) ||
      undefined
    const user = data?.user as Record<string, unknown> | undefined
    const username =
      (typeof data?.username === 'string' && data.username) ||
      (typeof user?.username === 'string' ? user.username : undefined) ||
      (typeof user?.login === 'string' ? user.login : undefined)

    // 身份锚点：优先用数字 id（站内 id 与 GitHub 名无关，不可比）
    const rawId = data?.id ?? user?.id
    const siteUserId = rawId !== undefined && rawId !== null ? String(rawId) : undefined

    if (!cookie && !token) {
      return { ok: false, error: '站点未返回会话凭据' }
    }

    // 若调用方给了期望身份，且双方都有可比对的值，则必须一致，否则视为串号
    if (expectUserId && siteUserId && expectUserId !== siteUserId) {
      return {
        ok: false,
        error: `授权身份与所选账号不一致（期望 ${expectUserId}，实际 ${siteUserId}），已拒绝`
      }
    }

    return { ok: true, cookie, token, username, siteUserId }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 生成稳定的账号 ID。 */
export function newId(): string {
  return randomBytes(8).toString('hex')
}
