import type { CheckinMode, Site, SiteKind } from '../../shared/types'

/**
 * 站点协议表：把「刷新额度 / 签到状态 / 签到动作 / 奖励流水」四件事的端点与字段，
 * 从散落的 if 变成一份可配置的数据。加站 = 加一份数据，不动引擎。
 *
 * 移植自上游 AutoSign SiteProfile.java（AGPL-3.0-or-later）。
 * 端点判定全部来自上游的真机实测 + 阴性对照，不是猜测。
 */

export function hostOf(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

export function kindOf(site: Pick<Site, 'baseUrl' | 'kind'>): SiteKind {
  return site.kind ?? 'NEWAPI'
}

/** 刷新额度用的会话端点（按顺序探测，第一个非 404 的即用）。 */
export function selfPaths(kind: SiteKind, baseUrl: string): string[] {
  const host = hostOf(baseUrl)
  if (kind === 'WELFARE') return ['/api/me', '/api/level']
  if (kind === 'SUB2API') {
    return host.includes('donation')
      ? ['/api/me', '/api/v1/auth/me']
      : ['/api/v1/auth/me', '/api/me']
  }
  return ['/api/user/self']
}

export function balanceFields(kind: SiteKind): string[] {
  if (kind === 'WELFARE' || kind === 'SUB2API') {
    return [
      'balance',
      'usd_balance',
      'available_balance',
      'credit_balance',
      'available_usd',
      'balance_usd',
      'available'
    ]
  }
  return ['quota']
}

export function usedFields(kind: SiteKind): string[] {
  if (kind === 'WELFARE' || kind === 'SUB2API') {
    return [
      'usage_total_cost',
      'total_cost',
      'actual_cost',
      'account_cost',
      'used_usd',
      'total_used',
      'spent_usd',
      'used'
    ]
  }
  return ['used_quota']
}

/** 只读签到状态端点；空串表示该形态没有该接口。 */
export function checkinStatusPath(kind: SiteKind): string {
  if (kind === 'WELFARE') return '/api/checkin/status'
  if (kind === 'SUB2API') return ''
  return '/api/user/checkin'
}

/**
 * 签到动作端点。空串 = 该站没有签到接口。
 * agentrouter 实测 POST /api/user/checkin 为 404，当日额度由登录动作发放。
 */
export function checkinActionPath(site: Pick<Site, 'baseUrl' | 'kind'>): string {
  const kind = kindOf(site)
  if (kind === 'SUB2API') return ''
  if (kind === 'WELFARE') return '/api/checkin'
  if (hostOf(site.baseUrl).includes('agentrouter')) return ''
  return '/api/user/checkin'
}

export function rewardLogPath(kind: SiteKind): string {
  if (kind === 'WELFARE') return '/api/ledger'
  if (kind === 'SUB2API') return ''
  return '/api/log/self'
}

/** 该站签到是否需要 Turnstile 令牌。 */
export function checkinNeedsTurnstile(kind: SiteKind): boolean {
  return kind === 'WELFARE'
}

/** 该模式是否必须走真实浏览器上下文。 */
export function needsBrowserContext(mode: CheckinMode, kind: SiteKind): boolean {
  return mode === 'WEB_ONLY' || checkinNeedsTurnstile(kind)
}

/** 该模式是否「到账即置已签」。 */
export function marksCheckedOnCredit(mode: CheckinMode): boolean {
  return mode === 'RELOGIN'
}

export function modeName(mode: CheckinMode): string {
  return mode ?? 'BUTTON'
}

export function kindFromHost(baseUrl: string): SiteKind {
  const h = hostOf(baseUrl)
  if (h.includes('welfalre') || h.includes('welfare')) return 'WELFARE'
  if (h.includes('fengwind') || h.includes('donation')) return 'SUB2API'
  return 'NEWAPI'
}

/**
 * 由探测结果推断形态：/api/user/self 存在（任意非 404/405）即 NEWAPI；
 * 否则按福利站端点 /api/checkin/status 是否存在区分 WELFARE / SUB2API。
 */
export function inferKind(selfHttp: number, checkinHttp: number): SiteKind {
  if (selfHttp > 0 && selfHttp !== 404 && selfHttp !== 405) return 'NEWAPI'
  if (checkinHttp > 0 && checkinHttp !== 404 && checkinHttp !== 405) return 'WELFARE'
  return 'SUB2API'
}

export function isAnyRouter(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl)
    return (
      u.protocol === 'https:' &&
      u.hostname.toLowerCase() === 'anyrouter.top' &&
      (u.port === '' || u.port === '443') &&
      !u.username
    )
  } catch {
    return false
  }
}

/**
 * 奖励周期：按站点当地日界（北京 0 点 = 前一日 UTC 16:00）切分。
 * 站点使用日志的日窗与 checkin_date 都从当地 0 点起算（实测发放记录落在 00:07），
 * 上游核对同样按北京时间比对；按 UTC 日界会把 0 点~8 点的发放盖成「前一天」。
 */
const DAY_MS = 86_400_000
const BEIJING_OFFSET_MS = 8 * 3_600_000

export function rewardEpochMs(now: number): number {
  return Math.floor((now + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
}

export function rewardDate(now: number): string {
  return new Date(rewardEpochMs(now) + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

/** AnyRouter 的发放窗口在北京 08:00 开启；仅用作该站重登签到的闸门。 */
export function rewardWindowOpen(now: number): boolean {
  const shanghaiHour = new Date(now + 8 * 3_600_000).getUTCHours()
  return shanghaiHour >= 8
}

/** 今日是否已在当前奖励周期内签到（按回执时间与日期双重校验）。 */
export function checkedInThisPeriod(
  receipt: { at: number; date: string; ok: boolean } | undefined,
  now: number
): boolean {
  if (!receipt || !receipt.ok) return false
  if (receipt.date !== rewardDate(now)) return false
  return receipt.at >= rewardEpochMs(now) && receipt.at <= now
}
