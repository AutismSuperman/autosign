import { session } from 'electron'
import { accountPartition } from './partition'

/**
 * 第三方登录态（GitHub / Linux DO）的加密备份与恢复。
 *
 * 为什么需要备份：静默重授权完全依赖账号分区里那份 GitHub / Linux DO 会话。
 * 但分区是 Chromium 的磁盘状态，换一台电脑、重装应用、清理缓存都会丢；
 * 一旦丢了，`hasProviderSession` 判定为 false，自动流程直接放弃，
 * 表现就是「每天都要手动点一次重新授权」。
 *
 * 因此授权成功时把第三方域名的 Cookie 序列化后交给账号记录加密落盘
 * （与站点会话同一套 safeStorage 保护），需要时再写回分区。
 * 只处理第三方登录域名，绝不备份站点自身的会话 Cookie。
 *
 * 恢复策略：只在分区里**缺同名 Cookie** 时写入。分区里的值更新，
 * 覆盖回去反而会把刚轮换过的会话打坏。
 */

export interface StoredProviderCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  /** Unix 秒；缺省表示会话 Cookie。 */
  expirationDate?: number
}

/** 允许备份的第三方域名（登录态只存在这些域上）。 */
const PROVIDER_HOSTS = ['github.com', 'www.github.com', 'linux.do', 'connect.linux.do']

export function cookieHost(domain: string): string {
  return (domain ?? '').toLowerCase().replace(/^\./, '')
}

export function isProviderDomain(domain: string): boolean {
  return PROVIDER_HOSTS.includes(cookieHost(domain))
}

function isExpired(c: StoredProviderCookie, now = Date.now()): boolean {
  return typeof c.expirationDate === 'number' && c.expirationDate * 1000 <= now
}

/** 解析备份。结构损坏或混入非第三方域名时按空处理，绝不把站点 Cookie 写回。 */
export function parseProviderCookies(raw: string | undefined): StoredProviderCookie[] {
  if (!raw) return []
  try {
    const list = JSON.parse(raw) as StoredProviderCookie[]
    if (!Array.isArray(list)) return []
    return list.filter(
      (c) =>
        !!c &&
        typeof c.name === 'string' &&
        typeof c.value === 'string' &&
        isProviderDomain(c.domain ?? '')
    )
  } catch {
    return []
  }
}

/** 把分区里的第三方登录态序列化成可落盘的字符串；没有则返回 undefined。 */
export async function captureProviderCookies(
  siteId: string,
  accountId: string
): Promise<string | undefined> {
  try {
    const ses = session.fromPartition(accountPartition(siteId, accountId))
    const list = await ses.cookies.get({})
    const kept = list
      .filter((c) => isProviderDomain(c.domain ?? '') && !!c.value)
      .map<StoredProviderCookie>((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? '',
        path: c.path ?? '/',
        secure: c.secure === true,
        httpOnly: c.httpOnly === true,
        sameSite: c.sameSite ?? 'unspecified',
        ...(typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {})
      }))
      .filter((c) => !isExpired(c))
    if (kept.length === 0) return undefined
    return JSON.stringify(kept)
  } catch {
    return undefined
  }
}

/**
 * 把备份写回分区。返回实际写入的条数。
 *
 * `__Host-` 前缀的 Cookie（GitHub 的 __Host-user_session_same_site）有额外约束：
 * 必须 Secure、Path=/、且不能带 Domain 属性，否则 Chromium 直接拒收。
 * 因此这一类单独用 host-only 形式写入。
 */
export async function restoreProviderCookies(
  siteId: string,
  accountId: string,
  raw: string | undefined
): Promise<number> {
  const list = parseProviderCookies(raw)
  if (list.length === 0) return 0

  try {
    const ses = session.fromPartition(accountPartition(siteId, accountId))
    const existing = await ses.cookies.get({})
    const have = new Set(
      existing.map((c) => `${cookieHost(c.domain ?? '')}|${c.name}`)
    )
    let restored = 0
    for (const c of list) {
      if (isExpired(c)) continue
      const host = cookieHost(c.domain)
      if (have.has(`${host}|${c.name}`)) continue
      const path = c.path || '/'
      const hostOnly = c.name.startsWith('__Host-')
      try {
        await ses.cookies.set({
          url: `https://${host}${hostOnly ? '/' : path}`,
          name: c.name,
          value: c.value,
          ...(hostOnly ? {} : { domain: c.domain }),
          path: hostOnly ? '/' : path,
          secure: hostOnly ? true : c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          ...(typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {})
        })
        have.add(`${host}|${c.name}`)
        restored++
      } catch {
        // 单个 Cookie 写不进去不影响其余（不同 Chromium 版本对属性的校验略有差异）
      }
    }
    return restored
  } catch {
    return 0
  }
}
