import type { Site } from '../../shared/types'
import { needsRefresh, renewToken } from './session'
import type { SessionDeps } from './session'

/**
 * 会话保活。
 *
 * 背景：New API 的 access_token 只有 15 分钟有效期。如果等到读额度时才
 * 发现过期，每次都要「请求 → 401 → 续期 → 重试」，既慢又容易在续期失败的
 * 瞬间被判定为会话失效。上游 autosign 的做法是定期主动续期，让会话始终有效。
 *
 * 这里在应用运行期间每隔一段时间扫一遍账号：
 *   - token 快过期（< 5 分钟）→ 主动续期
 *   - cookie 类会话（无 token）→ 不发请求，避免无意义流量
 *   - 续期失败不做任何破坏性处理，交给下次业务请求如实报错
 *
 * 只处理 NEWAPI 系站点：其它形态没有 refresh 端点，续期无意义。
 */

/** 扫描间隔：5 分钟。比 15 分钟的 token 寿命短得多，足够在过期前续上。 */
const KEEPALIVE_INTERVAL_MS = 5 * 60_000

/**
 * 会话自动恢复的常规扫描间隔：10 分钟。
 *
 * 被动恢复（刷新额度、签到时顺带重建）只在用户或定时任务触发时发生。
 * 如果那次重建恰好撞上网络抖动、站点限流或 WAF 拦截，账号就会一直挂着
 * 「需要重新授权」，直到用户自己想起来点一下 —— 这正是「每天都要手动点」的由来。
 * 后台定期再试，多数瞬时故障都能自愈。RELOGIN 站点（AgentRouter / AnyRouter）
 * 的当日额度就靠登录动作发放，恢复得越及时，越不容易错过当天的发放窗口。
 */
const RECOVER_INTERVAL_MS = 10 * 60_000

/**
 * 会话自动恢复的扫描间隔（上一次全部失败时）：2 分钟。
 *
 * 静默重授权要开隐藏窗口走第三方 OAuth，连续失败多半是瞬时故障（WAF 拦截、
 * 代理抖动、GitHub 侧风控）。立即放弃后要等整个间隔才再试，把明明几秒后
 * 就能自愈的账号晾了十分钟；反过来若一直失败，高频重试也只是白开窗口。
 * 因此失败时切到短间隔快速重试，一旦有账号恢复就回到常规节奏。
 */
const RECOVER_FAST_MS = 2 * 60_000

/** 连续无进展的恢复轮数上限：超过则退回常规间隔，避免无限快节奏重试。 */
const RECOVER_FAST_ROUNDS = 3

export interface KeepAliveDeps {
  proxy: () => Promise<string>
  sites: () => Site[]
  sessionFor: (siteId: string, accountId: string, proxy: string) => SessionDeps
  log: (message: string) => void
  /**
   * 可选：对一个「会话已失效、自动恢复失败」的账号再试一次恢复。
   *
   * 由主进程实现为「重新读一次额度」（读通就说明恢复成功、标记会被清掉）。
   * 不提供时只做令牌续期，行为与旧版一致。
   */
  recover?: (accountId: string) => Promise<{ ok: boolean; error?: string }>
}

/** 扫一遍所有账号，把快过期的令牌续掉。返回续期成功的数量。 */
export async function keepAliveOnce(deps: KeepAliveDeps): Promise<{ renewed: number; total: number }> {
  let renewed = 0
  let total = 0
  const proxy = await deps.proxy()

  for (const site of deps.sites()) {
    for (const account of site.accounts) {
      if (!account.token && !account.cookie) continue
      // 续期换的是 access_token：没有 token 的纯 session 站（如 AgentRouter）
      // 每轮都去调 refresh 只会稳定拿 404，白刷日志与流量。
      if (!account.cookie || !account.token) continue
      total++
      if (!needsRefresh(account.token)) continue
      try {
        const token = await renewToken(site, account, deps.sessionFor(site.id, account.id, proxy), false)
        if (token) renewed++
      } catch {
        // 单个账号续期失败不影响其它账号
      }
    }
  }
  return { renewed, total }
}

/**
 * 扫一遍所有「需要手动登录」的账号，再试一次自动恢复。
 *
 * 只处理已经标记 needsRelogin 的账号：它们上一次恢复确实失败了，
 * 这里给一次重试机会，成功就把标记清掉，用户完全不用介入。
 * 不碰健康账号 —— 无意义的重建只会制造多余的登录会话。
 */
export async function recoverOnce(
  deps: KeepAliveDeps
): Promise<{ recovered: number; total: number }> {
  if (!deps.recover) return { recovered: 0, total: 0 }
  const pending = deps
    .sites()
    .flatMap((site) => site.accounts.map((account) => ({ site, account })))
    .filter(({ account }) => account.needsRelogin === true)
  if (pending.length === 0) return { recovered: 0, total: 0 }

  let recovered = 0
  for (const { account } of pending) {
    try {
      const r = await deps.recover(account.id)
      if (r.ok) recovered++
    } catch {
      // 单个账号失败不影响其余
    }
  }
  return { recovered, total: pending.length }
}

/** 启动保活定时器。返回停止函数。 */
export function startKeepAlive(deps: KeepAliveDeps): () => void {
  let stopped = false
  /** 快节奏连续重试的轮数：达到上限后退回常规间隔。 */
  let fastRounds = 0
  /** 当前生效的恢复间隔；用 setTimeout 链而不是 setInterval，间隔可动态调整。 */
  let recoverTimer: NodeJS.Timeout | null = null

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const r = await keepAliveOnce(deps)
      if (r.renewed > 0) deps.log(`会话保活：已续期 ${r.renewed} / ${r.total} 个账号`)
    } catch {
      // 保活失败是静默的，不影响主流程
    }
  }

  const recoverTick = async (): Promise<void> => {
    if (stopped) return
    try {
      const r = await recoverOnce(deps)
      if (r.recovered > 0) {
        deps.log(`会话恢复：${r.recovered} / ${r.total} 个账号已自动恢复，无需手动授权`)
        fastRounds = 0
      } else if (r.total > 0) {
        // 有待恢复账号但一个都没成：短暂退避（60 秒）后再试，
        // 避免立刻重打同一面墙；连续数轮无进展则退回常规间隔
        fastRounds++
      }
    } catch {
      // 恢复失败是静默的：下次扫描会再试
    }
    if (stopped) return
    const nextMs =
      fastRounds > 0 && fastRounds <= RECOVER_FAST_ROUNDS ? RECOVER_FAST_MS : RECOVER_INTERVAL_MS
    recoverTimer = setTimeout(() => void recoverTick(), nextMs)
    recoverTimer.unref?.()
  }

  // 启动后先跑一次，收掉已有快过期的令牌
  void tick()
  const timer = setInterval(() => void tick(), KEEPALIVE_INTERVAL_MS)
  timer.unref?.()

  // 会话恢复单独一条较慢的节奏：它要真的重建会话，开销比续期大
  recoverTimer = setTimeout(() => void recoverTick(), RECOVER_INTERVAL_MS)
  recoverTimer.unref?.()

  return () => {
    stopped = true
    clearInterval(timer)
    if (recoverTimer) clearTimeout(recoverTimer)
  }
}
