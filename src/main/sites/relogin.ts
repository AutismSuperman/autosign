import type { Account, Site } from '../../shared/types'
import { authHeaders, send } from '../net/httpClient'
import { isAnyRouter, selfPaths, rewardWindowOpen } from './profile'
import type { SessionDeps } from './session'

/**
 * RELOGIN 类站点的自动重登。
 *
 * AgentRouter / AnyRouter 没有签到端点：当日额度是在**登录动作**中发放的。
 * 因此「签到」等价于「登出 → 重新登录」，而登录本身必须走 OAuth，
 * 这里复用账号绑定的凭据把会话建回来（密码直登，或用第三方登录态静默授权）。
 *
 * 判据（与上游一致，来自用户实证）：**只认余额增量**，不认任何
 * `sign_in` 之类的响应。原因是这些接口的返回值与实际到账并不同步，
 * 曾经出现过「响应成功但余额没变」。增量阈值取 $15 而非 $25，
 * 因为签到时可能在同时消耗余额。
 *
 * 两条硬约束：
 *   1. **登出前必须确认能登回来**。登不回来就绝不能登出 —— 那会把「今天
 *      还没领到奖」变成「账号彻底掉线，必须手动授权」，比不签更糟。
 *   2. 登出后不再指望站点靠残留 Cookie 自己恢复：登出就是为了清掉它。
 *      恢复一律走 `rebuild`（保存的密码 / 分区里的第三方登录态）。
 *
 * 另外，如果会话被保活续着，就永远登不出去、也领不到奖。
 * 因此对这类站点，签到前**不得**做会话续期 —— 由调用方保证。
 */

const MIN_CREDIT_USD = 15

/**
 * 到账判据（纯函数，便于直接测试）。
 *
 * 只有余额增量达标才算到账。响应里的 success / sign_in 一律不作为依据，
 * 因为这些接口的返回值与实际到账并不同步。
 *
 * 注意：**增量不是奖励金额**。同时段的正常消耗、其它入账都会算进去，
 * 所以这里只回答「有没有到账」，绝不把它当作「签到 +$xx」展示。
 */
export function judgeCredit(
  before: number | undefined,
  after: number | undefined
): { credited: boolean; delta: number; message: string } {
  if (before === undefined || after === undefined) {
    return {
      credited: false,
      delta: 0,
      message: '已重登但余额读取失败，无法确认到账，请稍后刷新核对'
    }
  }
  const delta = Math.round((after - before) * 100) / 100
  if (delta >= MIN_CREDIT_USD) {
    return { credited: true, delta, message: '重登成功，已检测到额度增加' }
  }
  if (delta > 0) {
    return {
      credited: false,
      delta,
      message: `已重登，额度仅增加 $${delta.toFixed(2)}，可能今日已领或正在消耗，请刷新核对`
    }
  }
  return {
    credited: false,
    delta,
    message: '已重登，未检测到额度增加，可能今日已领，请刷新核对'
  }
}

export interface ReloginDeps {
  proxy: string
  /** 读当前可用余额（USD）；读不到返回 undefined。 */
  readBalance: (fresh: boolean) => Promise<number | undefined>
  /** 登出当前站点会话。 */
  logout: () => Promise<boolean>
  /**
   * 登出前的能力检查：能不能用保存的凭据把会话建回来。
   * 返回 false 时**不登出**，直接如实失败。
   */
  canRelogin: () => Promise<{ ok: boolean; error?: string }>
  /** 登出后用保存的凭据重建会话（密码直登 / 静默 OAuth）。 */
  rebuild: () => Promise<{ ok: boolean; error?: string }>
  session: SessionDeps
  log: (level: 'info' | 'ok' | 'warn' | 'err', message: string, detail?: string) => void
}

export interface ReloginResult {
  ok: boolean
  already: boolean
  /**
   * 确认到账后的余额增量。仅用于日志与「有没有到账」的诊断，
   * **不是签到奖励金额**，不能当成「+$xx」的奖励展示。
   */
  reward?: number
  message: string
  /** 需要用户手动重新登录（凭据或第三方登录态都无法自动恢复时）。 */
  needVisible?: boolean
}

/**
 * 执行重登签到。
 *
 * 流程：能力检查 → 余额基线 → 登出 → 用凭据重建会话 → 余额复核 →
 * 增量达标才认为到账。
 *
 * 任何一步失败都不会留下「已登出但登不回来」的账号：能力检查不过就不登出；
 * 重建失败时把真实原因带回去，由界面提供「重新授权」入口。
 */
export async function reloginCheckin(
  site: Site,
  account: Account,
  deps: ReloginDeps
): Promise<ReloginResult> {
  const now = Date.now()

  if (!isAnyRouter(site.baseUrl) && !site.baseUrl.includes('agentrouter')) {
    return { ok: false, already: false, message: '该站点不支持重登签到' }
  }
  // 仅 AnyRouter 的发放窗口在北京 08:00 开启；AgentRouter 随站点当地 0 点日界发放，全天可重登领取
  if (isAnyRouter(site.baseUrl) && !rewardWindowOpen(now)) {
    return { ok: false, already: false, message: '未到北京时间 08:00，本周期尚未开始' }
  }

  // 0) 登出前先确认登得回来。登不回来就保持现状：宁可今天不领，也不能把账号弄掉线。
  const capability = await deps.canRelogin()
  if (!capability.ok) {
    // 带上「需要重新授权」这个固定说法：界面据此把账号标成会话失效并突出重授权入口
    const message = `需要重新授权：${capability.error ?? '原因未知'}（本次未登出，账号仍保持原状）`
    deps.log('warn', '重登前置检查未通过', capability.error)
    return { ok: false, already: false, needVisible: true, message }
  }

  // 1) 余额基线
  const before = await deps.readBalance(false)
  deps.log('info', '重登签到开始', `签到前余额=${before ?? '未知'}`)

  // 2) 登出：真实服务端注销，确保随后的登录会触发放额度
  const loggedOut = await deps.logout()
  deps.log(loggedOut ? 'info' : 'warn', loggedOut ? '登出已确认' : '登出未确认')

  // 3) 用保存的凭据把会话建回来。这一步同时完成「登录」，也就是发额度的动作。
  const rebuilt = await deps.rebuild()
  if (!rebuilt.ok) {
    const message = `需要重新授权：已登出但未能自动登回（${
      rebuilt.error ?? '原因未知'
    }）`
    deps.log('err', '重登失败', rebuilt.error)
    return { ok: false, already: false, needVisible: true, message }
  }

  // 4) 补发 sign_in（尽力而为，不作为判据）
  try {
    const paths = selfPaths('NEWAPI', site.baseUrl)
    void paths
    const fresh = deps.session.readAccount(account.id) ?? account
    await send(`${site.baseUrl.replace(/\/+$/, '')}/api/user/sign_in`, {
      method: 'POST',
      headers: {
        ...authHeaders(fresh.token, fresh.siteUserId),
        'Content-Type': 'application/json'
      },
      body: '{}',
      proxy: deps.proxy,
      cookie: fresh.cookie,
      timeoutMs: 15_000
    })
  } catch {
    deps.log('info', 'sign_in 未发送成功', '不影响到账判据')
  }

  // 5) 余额复核：只有增量达标才写回执
  const after = await deps.readBalance(true)
  const verdict = judgeCredit(before, after)

  deps.log(
    verdict.credited ? 'ok' : 'warn',
    verdict.credited ? `重登到账 +$${verdict.delta.toFixed(2)}` : '重登完成但未确认到账',
    `before=${before}；after=${after}；delta=${verdict.delta.toFixed(2)}；loggedOut=${loggedOut}`
  )

  if (verdict.credited) {
    return {
      ok: true,
      already: false,
      reward: verdict.delta,
      message: verdict.message
    }
  }
  return { ok: false, already: false, message: verdict.message }
}
