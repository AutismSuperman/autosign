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
 *   - 只处理密码类凭据；GitHub / Linux DO 需要 OAuth 授权窗口，不能静默完成
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
  return /会话已失效|需要重新授权|授权已过期|未登录|请先登录|AUTH_TOKEN|unauthorized/i.test(message)
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
