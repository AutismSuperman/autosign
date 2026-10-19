import type { Account, Site } from '../../shared/types'
import { passwordLogin } from '../auth/passwordLogin'

/**
 * 会话失效后的自动重建。
 *
 * 站点会话会过期（token 15 分钟、gin session 也会被服务端清掉），
 * 旧实现遇到 401 一律返回「请重新登录」，把本来能自动完成的事推给用户。
 * 账号只要绑定了带密码的凭据，就能用同一条登录接口重新换一份会话。
 *
 * 边界：
 *   - 密码凭据直接打登录接口
 *   - GitHub / Linux DO 凭据先试静默重授权；分区登录态没了但存了密码时，
 *     用密码在第三方站点重新登录一次，再点授权（仍然全程隐藏窗口）
 *   - 站点要求人机验证时，用隐藏窗口复用它自己的 Turnstile 挂件取令牌（不破解、不代答）
 *   - 取不到令牌就如实失败，让用户手工处理
 */

export interface ReloginAttempt {
  ok: boolean
  cookie?: string
  token?: string
  siteUserId?: string
  error?: string
}

/** 会话是否已失效（读额度、签到都靠这个判断要不要重建）。 */
export function isSessionExpired(message: string | undefined, status?: number): boolean {
  if (status === 401 || status === 403) return true
  if (!message) return false
  return /会话已失效|需要重新授权|需要重新登录|授权已过期|未登录|请先登录|AUTH_TOKEN|unauthorized/i.test(
    message
  )
}

/**
 * 这条分区 Cookie 是否代表 GitHub / Linux DO 的第三方登录态。
 *
 * 抽成纯函数是因为「能不能静默重授权」完全取决于它：判定写错一次，
 * 表现就是每天都要求用户手动授权。
 */
export function isProviderSessionCookie(domain: string, name: string, value: string): boolean {
  if (!value) return false
  const host = (domain ?? '').toLowerCase().replace(/^\./, '')
  if (host !== 'github.com' && host !== 'www.github.com' && host !== 'linux.do') return false
  return /^(user_session|_t|_forum_session)$/i.test(name)
}

export interface ReloginCapability {
  ok: boolean
  error?: string
}

/**
 * 登出后还能不能自己登回来。
 *
 * RELOGIN 站点的「签到」必须先真登出，所以一旦登不回来，账号就比之前更糟。
 * 这里在动手之前把「登回能力」算清楚：
 *   1. 密码凭据 → 调登录接口，最稳
 *   2. OAuth 凭据且保存了密码 → 用密码登录第三方站点，再点授权
 *   3. OAuth 凭据且分区里还有第三方登录态 → 直接点授权
 *   4. 都没有 → 不能登出，交还用户
 */
export function reloginCapability(
  credential: { provider?: string; username?: string; password?: string } | undefined,
  hasProviderSession: boolean,
  accountProvider?: string
): ReloginCapability {
  // 账号没关联凭据不代表登不回来：分区里还留着第三方登录态就够
  const provider = credential?.provider ?? accountProvider ?? 'password'
  if (provider === 'password') {
    return credential?.password
      ? { ok: true }
      : {
          ok: false,
          error: credential
            ? `凭据 ${credential.username ?? ''} 没有保存密码`
            : '该账号未关联凭据，无法自动登回'
        }
  }
  if (credential?.password) return { ok: true }
  if (hasProviderSession) return { ok: true }
  const who = provider === 'linuxdo' ? 'Linux DO' : 'GitHub'
  return { ok: false, error: `分区内没有 ${who} 登录态，且凭据未保存密码` }
}

/** 站点是否明确要求人机验证（登录接口也会校验）。 */
export function needsTurnstile(message: string | undefined): boolean {
  if (!message) return false
  return /turnstile|captcha|人机验证|验证码|challenge|token 为空/i.test(message)
}

export interface RebuildDeps {
  proxy: string
  /** 主进程提供的凭据读取（含密码原文，仅内存中）。 */
  findCredential: (
    id: string
  ) => { id: string; provider?: string; username: string; password?: string; totpSecret?: string } | undefined
  /** 用隐藏窗口取 Turnstile 令牌；站点未开启验证时返回 undefined。 */
  acquireTurnstile?: () => Promise<string | undefined>
  /**
   * 静默重授权：分区里还留着 GitHub / Linux DO 登录态时，
   * 用隐藏窗口自己走一遍 OAuth，不需要用户操作。
   */
  silentReauth?: (provider: 'github' | 'linuxdo') => Promise<ReloginAttempt>
}

/**
 * 用账号绑定的凭据重新登录一次。
 *
 * 顺序很重要，按「打扰用户的程度」从低到高：
 *   1. 密码凭据 → 直接调登录接口（带 Turnstile 时再取令牌）
 *   2. OAuth 凭据 → 先试静默重授权（复用分区里的第三方登录态）
 *   3. 都不行 → 如实返回，由界面提供「重新授权」按钮
 *
 * 只有 3 才需要用户动手。「登录一次之后不用再管」靠的就是 1 和 2。
 */
export async function rebuildSession(
  site: Site,
  account: Account,
  deps: RebuildDeps
): Promise<ReloginAttempt> {
  if (!account.credentialId) {
    return { ok: false, error: '该账号未关联凭据，需要在站点重新授权一次' }
  }
  const credential = deps.findCredential(account.credentialId)
  if (!credential) {
    return { ok: false, error: '关联的凭据已被删除，需要在站点重新授权一次' }
  }

  // OAuth 身份：先尝试静默重授权，分区里的登录态往往还在
  if (credential.provider && credential.provider !== 'password') {
    const provider = credential.provider === 'linuxdo' ? 'linuxdo' : 'github'
    if (deps.silentReauth) {
      const silent = await deps.silentReauth(provider)
      if (silent.ok) return silent
      return {
        ok: false,
        error: `${silent.error ?? '静默重授权失败'}。请点「重新授权」手动完成一次`
      }
    }
    return {
      ok: false,
      error: `会话已过期，该账号用 ${
        provider === 'github' ? 'GitHub' : 'Linux DO'
      } 登录，请点「重新授权」完成一次`
    }
  }

  if (!credential.password) {
    return {
      ok: false,
      error: `凭据 ${credential.username} 没有保存密码，无法自动重新登录`
    }
  }

  const asCredential = { ...credential, provider: 'password' as const, createdAt: 0 }
  let login = await passwordLogin(site, asCredential, deps.proxy)

  // 登录接口也校验人机验证：取一次令牌再试
  if (!login.ok && needsTurnstile(login.error) && deps.acquireTurnstile) {
    const token = await deps.acquireTurnstile()
    if (token) {
      login = await passwordLogin(site, asCredential, deps.proxy, token)
    }
  }

  if (!login.ok) {
    return { ok: false, error: login.error }
  }
  return {
    ok: true,
    cookie: login.cookie,
    token: login.token,
    siteUserId: login.siteUserId
  }
}
