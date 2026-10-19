import type { AuthProvider, CheckinMode, SiteKind } from '@shared/types'

/**
 * 渲染层共享的展示文案与格式化助手。
 * 各视图统一从这里取，避免同一个 provider 在不同页面叫法不一致。
 */

export const PROVIDER_LABEL: Record<AuthProvider, string> = {
  github: 'GitHub',
  linuxdo: 'Linux DO',
  password: '邮箱 / 密码'
}

/** 账号行等紧凑场景用的短标签。 */
export const PROVIDER_SHORT: Record<AuthProvider, string> = {
  github: 'GitHub',
  linuxdo: 'Linux DO',
  password: '密码'
}

export const MODE_LABEL: Record<CheckinMode, string> = {
  BUTTON: '签到按钮',
  RELOGIN: '重登领取',
  LOGIN_GRANT: '登录即得',
  WEB_ONLY: '仅网页'
}

export const KIND_LABEL: Record<SiteKind, string> = {
  NEWAPI: 'New API',
  SUB2API: 'Sub2API',
  WELFARE: 'Welfare'
}

export function providerLabel(p: AuthProvider): string {
  return PROVIDER_LABEL[p] ?? p
}

/** 签到按钮的文案随模式变化：重登类站点说「重登领取」比「签到」更准确。 */
export function checkinLabel(mode: CheckinMode): string {
  return mode === 'RELOGIN' ? '重登领取' : '签到'
}

/**
 * 会话失效后的恢复按钮文案，按登录方式区分。
 *
 * 密码登录没有「授权」这一步 —— 对它说「重新授权」会让人以为要跳转第三方，
 * 实际只是用保存的账号密码重新登录一次。
 */
export function reloginLabel(provider: AuthProvider): string {
  return provider === 'password' ? '重新登录' : '重新授权'
}

export function money(v: number | undefined): string {
  if (v === undefined) return '—'
  return `$${v.toFixed(2)}`
}

/**
 * 判断某条签到回执是否属于「今天」。
 *
 * 与主进程 rewardDate 使用同一套北京时间日界：站点奖励周期在北京 0 点切换。
 * 界面不能只看 `ok` —— 过了 0 点，昨天的成功回执仍然是 ok，但已经不属于今天。
 */
export function isCheckedToday(
  receipt: { at: number; date: string; ok: boolean } | undefined,
  now = Date.now()
): boolean {
  if (!receipt?.ok) return false
  return receipt.date === beijingDate(now)
}

/** 北京时间的当天日期（YYYY-MM-DD），与主进程 rewardDate 保持一致。 */
export function beijingDate(now = Date.now()): string {
  const offset = 8 * 3_600_000
  const day = 86_400_000
  return new Date(Math.floor((now + offset) / day) * day).toISOString().slice(0, 10)
}

/**
 * 这条错误是不是「会话已失效」。
 *
 * 会话失效时界面要突出「重新授权」入口，而不是让用户对着红色的
 * 「会话已失效」文字自己去站点卡片底部找「添加账号」。
 */
export function isSessionExpired(message: string | undefined): boolean {
  if (!message) return false
  return /会话已失效|需要重新授权|授权已过期|授权已过期|未登录|请先登录|AUTH_TOKEN|unauthorized/i.test(
    message
  )
}

/**
 * 把刷新失败的原因压成一句可扫读的标签文案。
 *
 * 优先级：先告诉用户「该怎么办」（换节点 / 重新授权），
 * 再不济才说明「这是上次的数据」。完整原因始终在悬停提示里。
 */
export function describeStatusError(status: {
  ok: boolean
  error?: string
  available?: number
}): string {
  const err = status.error ?? ''
  if (/防护|拦截|风控|challenge|WAF/i.test(err)) return '节点被拦截，换节点试试'
  if (isSessionExpired(err)) return '会话失效，需重新授权'
  if (/限流/.test(err)) return '站点限流，稍后再试'
  if (status.available !== undefined) return '刷新失败（显示上次数据）'
  return err.slice(0, 24) || '刷新失败'
}

/**
 * 把时间戳格式化成北京时间的 HH:mm。
 *
 * 签到日界固定按北京时间切换，界面上「上次签到 23:44」也必须用同一时区，
 * 否则海外用户或 CI（UTC）会看到与日期对不上的时间。
 * 这里直接按 +8 偏移算，不依赖运行环境的本地时区设置。
 */
export function beijingTime(ts: number): string {
  const offset = 8 * 3_600_000
  const d = new Date(ts + offset)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/**
 * 签到状态文案。
 *
 * 过了北京时间 0 点，昨天的回执就失效：直接显示「未签」，
 * 但要保留「上次签于 …」作为悬停说明，让人知道上次是什么时候签的。
 * 签到成功后再变回「已签」。
 */
export function checkinText(
  receipt: { at: number; date: string; ok: boolean; already: boolean; reward?: number } | undefined,
  now = Date.now()
): { label: string; reward?: number; stale: boolean; hint?: string } {
  if (!receipt?.ok) return { label: '未签', stale: false }
  const time = beijingTime(receipt.at)
  if (isCheckedToday(receipt, now)) {
    return {
      label: receipt.already ? '今日已签' : '已签',
      reward: receipt.reward,
      stale: false
    }
  }
  // 跨天：今日尚未签到，但把上次记录留在悬停提示里
  const hint = `上次签到 ${receipt.date} ${time}${receipt.reward ? `，+$${receipt.reward.toFixed(2)}` : ''}`
  return { label: '未签', stale: true, hint }
}

export function timeAgo(ts: number | undefined): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 凭据头像字母：GitHub 用 GH，Linux DO 用 L，邮箱/密码用 @。 */
export function providerAvatar(p: AuthProvider): string {
  if (p === 'linuxdo') return 'L'
  if (p === 'password') return '@'
  return 'GH'
}
