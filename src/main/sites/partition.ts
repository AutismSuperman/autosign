/**
 * 「站点 × 账号」的持久化会话分区。
 *
 * 整个应用只有这一个分区命名规则：OAuth 授权、额度读取、签到、Turnstile
 * 全部落在同一个分区里。这决定了「授权一次之后还要不要手动再授权」：
 *
 *   - 分区持久化在磁盘上，重启后 Cookie 仍在（Chromium 自动管理）
 *   - 授权时 GitHub / 站点的会话 Cookie 就存在这里
 *   - 后续额度读取与签到复用同一份 Cookie，站点认得这个会话
 *
 * 早期版本 OAuth 用 `auth-<site>-<account>`、签到用 `checkin-<site>_<account>`，
 * 两套分区互不相通：授权拿到的 GitHub 会话签到时根本看不到，于是每次都要
 * 重新授权。命名统一后，「登录一次、之后自动复用」才成立。
 *
 * 分隔符统一用 `_`，并把非法字符替换掉，避免分区名被 Chromium 归一化后撞车。
 */
export function accountPartition(siteId: string, accountId: string): string {
  const clean = (v: string): string => v.replace(/[^A-Za-z0-9_-]/g, '_')
  return `persist:account-${clean(siteId)}_${clean(accountId)}`
}

/** 历史分区名。升级后要把里面的 Cookie 搬到新分区，否则「之前授权过」的登录态会丢。 */
export function legacyPartitions(siteId: string, accountId: string): string[] {
  return [
    `persist:auth-${siteId}-${accountId}`,
    `persist:checkin-${siteId}_${accountId}`,
    `persist:checkin-${`${siteId}|${accountId}`.replace(/[^A-Za-z0-9_-]/g, '_')}`
  ]
}
