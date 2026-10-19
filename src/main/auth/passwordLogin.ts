import type { Account, AuthProvider, Credential, Site } from '../../shared/types'
import { parseJson, send } from '../net/httpClient'
import { mergeSetCookies } from '../net/waf'

/**
 * 邮箱 / 用户名 + 密码登录。
 *
 * New API 系站点（AgentRouter、SeekAI、KKtoken 等）原生支持
 * `POST /api/user/login`，参数是 `{ username, password }`，
 * `username` 字段既能填用户名也能填邮箱。这条路不需要打开任何窗口，
 * 也不需要 OAuth —— 适合没有第三方账号、或不想授权 OAuth 的用户。
 *
 * 实测要点（agentrouter.org）：
 *   - 空参数返回「无效的参数」，说明端点存在且校验参数名
 *   - 用 `email` 字段会返回「无效的参数」，只认 `username`
 *   - 凭据错误统一返回「用户名或密码错误，或用户已被封禁」，
 *     不泄露账号是否存在，因此无法据此区分「密码错」与「账号不存在」
 *   - 成功时业务凭据在 Set-Cookie（session），access_token 可能为 null
 */

export interface PasswordLoginResult {
  ok: boolean
  cookie?: string
  token?: string
  username?: string
  siteUserId?: string
  error?: string
}

/** 凭据错误时的站点提示是否属于「明确的认证失败」（而非网络或风控问题）。 */
export function isAuthRejection(message: string): boolean {
  return /用户名或密码错误|密码错误|账号或密码|invalid.*(credential|password)|incorrect.*password|authentication failed/i.test(
    message
  )
}

/** 站点是否明确要求人机验证。 */
export function needsVerification(message: string): boolean {
  return /turnstile|captcha|人机验证|验证码|challenge/i.test(message)
}

/**
 * 用用户名或邮箱 + 密码登录。
 *
 * @param credential 必须含 username；password 为空时直接失败，不尝试空密码登录
 */
export async function passwordLogin(
  site: Site,
  credential: Credential,
  proxy: string,
  /** New API 的登录接口可能要求 Turnstile；由调用方用隐藏窗口取好传入。 */
  turnstileToken?: string
): Promise<PasswordLoginResult> {
  const username = (credential.username ?? '').trim()
  const password = credential.password ?? ''

  if (!username) return { ok: false, error: '用户名为空' }
  if (!password) return { ok: false, error: '该凭据没有保存密码，请先补充' }

  const base = site.baseUrl.replace(/\/+$/, '')
  // 站点把 token 放在 query（?turnstile=），实测 New API 系两种形态都存在
  const endpoint = turnstileToken
    ? `${base}/api/user/login?turnstile=${encodeURIComponent(turnstileToken)}`
    : `${base}/api/user/login`
  let res
  try {
    res = await send(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
      proxy,
      timeoutMs: 25_000
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const json = parseJson<{
    success?: boolean
    message?: string
    data?: Record<string, unknown>
  }>(res.body)

  const message = json?.message ?? `HTTP ${res.status}`

  // 明确要求人机验证：如实上报，不做任何绕过尝试
  if (needsVerification(message)) {
    return { ok: false, error: `站点要求人机验证：${message}。请改用第三方登录或到网页端完成一次登录` }
  }

  if (res.status === 429) {
    return { ok: false, error: '站点限流（429），请稍后再试或更换代理节点' }
  }

  if (res.status !== 200 || json?.success !== true) {
    if (isAuthRejection(message)) {
      return { ok: false, error: `登录失败：${message}` }
    }
    return { ok: false, error: message }
  }

  // 成功：凭据在 Set-Cookie，也可能附带 access_token
  const cookie = mergeSetCookies('', res.setCookies)
  const data = json.data ?? {}
  const user = data.user as Record<string, unknown> | undefined

  const token =
    (typeof data.access_token === 'string' && data.access_token) ||
    (typeof data.accessToken === 'string' && data.accessToken) ||
    undefined

  const rawId = data.id ?? user?.id
  const siteUserId = rawId !== undefined && rawId !== null ? String(rawId) : undefined

  const loginName =
    (typeof data.username === 'string' && data.username) ||
    (typeof user?.username === 'string' ? user.username : undefined) ||
    username

  if (!cookie && !token) {
    // 登录接口说成功但没给任何凭据：不能当作成功，否则后续每次请求都会 401
    return { ok: false, error: '站点返回成功但未下发会话凭据，请改用第三方登录' }
  }

  return { ok: true, cookie, token, username: loginName, siteUserId }
}

/** 构造登录后的账号对象（供主进程落库）。 */
export function accountFromPasswordLogin(
  site: Site,
  accountId: string,
  credential: Credential,
  result: PasswordLoginResult
): Account {
  return {
    id: accountId,
    siteId: site.id,
    label: result.username ?? credential.username,
    provider: 'password' as AuthProvider,
    siteUserId: result.siteUserId,
    credentialId: credential.id,
    cookie: result.cookie,
    token: result.token,
    createdAt: Date.now()
  }
}
