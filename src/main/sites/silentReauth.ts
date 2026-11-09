import { session } from 'electron'
import type { Account, Site } from '../../shared/types'
import { accountPartition } from './partition'
import { runOAuth } from './oauth'
import { isProviderSessionCookie } from './reloginSession'
import { captureProviderCookies, restoreProviderCookies } from './providerSession'
import type { ReloginAttempt } from './reloginSession'

/**
 * 静默重授权：会话过期时，用账号分区里已有的第三方登录态自动重建会话。
 *
 * 目标「登录一次之后就不用再管」：OAuth 只要成功过一次，GitHub / Linux DO
 * 的登录 Cookie 就留在了账号自己的分区里。之后站点会话过期，重走一遍
 * 授权流程是**不需要用户输入密码**的 —— 第三方站点认得那个 Cookie，
 * 直接把授权页显示出来、点一下「Authorize」就换到新会话。
 *
 * 分区里的第三方登录态也会失效（GitHub 的 user_session 有期限），
 * 因此凭据里存了密码时会退回「用密码在第三方站点重新登录 → 点授权」。
 * 两条路都走不通才交还用户。
 *
 * 与 runOAuth 的区别：
 *   - 全程 `show: false`，不打扰用户
 *   - 只在确实有自动登录手段时才可能成功
 *   - 需要用户手动输入密码 / 过人机验证时，立即放弃并返回原因，
 *     由界面提供「重新授权」按钮交给用户处理
 */

/** 静默重授权可用的凭据信息：只有主进程内存里才有密码原文。 */
export interface SilentCredential {
  username: string
  password?: string
  totpSecret?: string
}

export interface SilentReauthDeps {
  proxy: string
  /** 凭据（含密码与 TOTP），用于分区登录态失效后重新登录第三方站点。 */
  credential?: SilentCredential
  timeoutMs?: number
  /**
   * 账号记录里保存的第三方登录态备份。
   *
   * 分区里的 Cookie 可能因为换机器、重装、清理缓存而消失，
   * 有备份就先写回分区，避免为了一份本来还活着的登录态去打扰用户。
   */
  providerCookies?: string
  /** 本轮是否把备份写回了分区，供调用方决定要不要重新采集（便于诊断）。 */
  onRestored?: (count: number) => void
}

/** 从分区 cookie 里判断是否还留着第三方登录态。 */
export async function hasProviderSession(site: Site, account: Account): Promise<boolean> {
  const ses = session.fromPartition(accountPartition(site.id, account.id))
  try {
    const list = await ses.cookies.get({})
    return list.some((c) => isProviderSessionCookie(c.domain ?? '', c.name, c.value))
  } catch {
    return false
  }
}

/**
 * 确保分区里有第三方登录态：没有就先用加密备份恢复。
 *
 * 只按 id 操作而不要求完整账号对象：重新授权时账号可能还没落库。
 * 这是「换台电脑也不用重新授权」的关键一步 —— 备份存在账号记录里
 * （safeStorage 加密），不依赖 Chromium 的分区存储。
 */
export async function ensureProviderSession(
  siteId: string,
  accountId: string,
  providerCookies: string | undefined
): Promise<{ alive: boolean; restored: number }> {
  try {
    const ses = session.fromPartition(accountPartition(siteId, accountId))
    const list = await ses.cookies.get({})
    if (list.some((c) => isProviderSessionCookie(c.domain ?? '', c.name, c.value))) {
      return { alive: true, restored: 0 }
    }
  } catch {
    // 读不到分区时继续尝试用备份恢复
  }
  const restored = await restoreProviderCookies(siteId, accountId, providerCookies)
  return { alive: restored > 0, restored }
}

/** 授权成功后采集当前分区里的第三方登录态，返回可加密落盘的字符串。 */
export async function snapshotProviderSession(
  site: Site,
  accountId: string
): Promise<string | undefined> {
  return captureProviderCookies(site.id, accountId)
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
  const credential = deps.credential
  // 分区里的登录态可能因为换机器 / 重装 / 清缓存而消失：
  // 先用账号记录里的加密备份把它补回去，再判断能不能静默走完。
  const providerState = await ensureProviderSession(site.id, account.id, deps.providerCookies)
  deps.onRestored?.(providerState.restored)
  // 备份也没有、也没有能重登的密码：静默走不通，直接说清楚，别白开窗口
  if (!providerState.alive && !credential?.password) {
    return {
      ok: false,
      error:
        provider === 'github'
          ? '分区内没有 GitHub 登录态，且凭据未保存密码，需要在应用内重新授权一次'
          : '分区内没有 Linux DO 登录态，且凭据未保存密码，需要在应用内重新授权一次'
    }
  }

  // 取 state、表单处理、回调兑换和分区锁共用手动授权实现，避免兼容性分叉。
  return runOAuth(site, account.id, provider, deps.proxy, credential, {
    silent: true,
    timeoutMs: deps.timeoutMs,
    expectedSiteUserId: account.siteUserId
  })
}
