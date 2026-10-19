import { session } from 'electron'
import type { Site } from '../../shared/types'
import { accountPartition, legacyPartitions } from './partition'

/**
 * 分区迁移：把旧分区里的 Cookie 搬到统一的账号分区。
 *
 * 早期版本 OAuth 用 `auth-<site>-<account>`、签到用 `checkin-<site>_<account>`，
 * 与现在统一的 `account-<site>_<account>` 不是同一个分区。升级后如果不管，
 * 分区里就不会有「之前授权过的 GitHub 登录态」，静默重授权全部失败，
 * 用户被迫重新授权一遍 —— 与「登录一次就不用管」的目标相反。
 *
 * 因此启动时做一次性搬运：把旧分区里 github.com / linux.do / 站点域名的
 * Cookie 原样写进新分区。只在目标分区缺该 Cookie 时写入，不覆盖已有更新值。
 */

/** 判断一个 Cookie 是否值得搬运（第三方登录态 + 站点自身会话）。 */
function worthCopy(domain: string, siteHost: string): boolean {
  const d = domain.toLowerCase()
  if (/github\.com|linux\.do/.test(d)) return true
  return siteHost.length > 0 && d.includes(siteHost.replace(/^www\./, ''))
}

/** 把一个账号的旧分区 Cookie 迁到新分区。返回搬迁数量。 */
export async function migrateAccountPartition(site: Site, accountId: string): Promise<number> {
  const target = session.fromPartition(accountPartition(site.id, accountId))
  let siteHost = ''
  try {
    siteHost = new URL(site.baseUrl).hostname.toLowerCase()
  } catch {
    siteHost = ''
  }

  let moved = 0
  for (const legacy of legacyPartitions(site.id, accountId)) {
    const src = session.fromPartition(legacy)
    let cookies: Awaited<ReturnType<typeof src.cookies.get>> = []
    try {
      cookies = await src.cookies.get({})
    } catch {
      continue
    }
    if (cookies.length === 0) continue

    for (const c of cookies) {
      if (!worthCopy(c.domain ?? '', siteHost)) continue
      const url = `${c.secure ? 'https' : 'http'}://${(c.domain ?? '').replace(/^\./, '')}${
        c.path ?? '/'
      }`
      try {
        // 目标已有同名 Cookie 时不覆盖：那里的值更新
        const existing = await target.cookies.get({ url, name: c.name })
        if (existing.length > 0) continue
        await target.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate
        })
        moved++
      } catch {
        // 单个 Cookie 写不进去不影响其余
      }
    }
  }
  return moved
}
