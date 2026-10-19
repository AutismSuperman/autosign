import { BrowserWindow, session } from 'electron'
import type { Account, Site } from '../../shared/types'
import { authHeaders, send } from '../net/httpClient'
import { isAnyRouter, selfPaths, rewardWindowOpen } from './profile'
import type { SessionDeps } from './session'
import { accountPartition } from './partition'

/**
 * RELOGIN 类站点的自动重登。
 *
 * AgentRouter / AnyRouter 没有签到端点：当日额度是在**登录动作**中发放的。
 * 因此「签到」等价于「登出 → 重新登录」，而登录本身必须走 OAuth，
 * 这里用隐藏窗口复用账号分区里已有的 GitHhub / Linux DO 会话静默完成。
 *
 * 判据（与上游一致，来自用户实证）：**只认余额增量**，不认任何
 * `sign_in` 之类的响应。原因是这些接口的返回值与实际到账并不同步，
 * 曾经出现过「响应成功但余额没变」。增量阈值取 $15 而非 $25，
 * 因为签到时可能在同时消耗余额。
 *
 * 关键约束：如果会话被保活续着，就永远登不出去、也领不到奖。
 * 因此对这类站点，签到前**不得**做会话续期 —— 由调用方保证。
 */

const MIN_CREDIT_USD = 15

/**
 * 到账判据（纯函数，便于直接测试）。
 *
 * 只有余额增量达标才算到账。响应里的 success / sign_in 一律不作为依据，
 * 因为这些接口的返回值与实际到账并不同步。
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
    return { credited: true, delta, message: `重登成功，+$${delta.toFixed(2)} 已到账` }
  }
  if (delta > 0) {
    return {
      credited: false,
      delta,
      message: `已重登，余额仅增加 $${delta.toFixed(2)}，可能今日已领或正在消耗，请刷新核对`
    }
  }
  return {
    credited: false,
    delta,
    message: '已重登，未检测到余额增加，可能今日已领，请刷新核对'
  }
}

export interface ReloginDeps {
  proxy: string
  /** 读当前可用余额（USD）；读不到返回 undefined。 */
  readBalance: (fresh: boolean) => Promise<number | undefined>
  /** 登出当前站点会话。 */
  logout: () => Promise<boolean>
  session: SessionDeps
  log: (level: 'info' | 'ok' | 'warn' | 'err', message: string, detail?: string) => void
}

export interface ReloginResult {
  ok: boolean
  already: boolean
  reward?: number
  message: string
  /** 需要用户手动重新登录（隐藏窗口无法完成时）。 */
  needVisible?: boolean
}

/**
 * 在隐藏窗口里打开站点首页，让站点自身的会话触发出登录动作。
 *
 * 这里刻意不做 OAuth：账号分区里已有长期会话 Cookie，站点识别到会话后
 * 会自己完成登录流程并发放当日额度。若分区里没有有效会话，页面会落到
 * 登录页 —— 此时如实返回需要人工授权，不假装成功。
 */
async function silentRelogin(
  site: Site,
  account: Account,
  deps: ReloginDeps
): Promise<{ ok: boolean; error?: string; cookie?: string }> {
  // 与 OAuth 授权共用分区，重登能直接复用已授权的会话
  const ses = session.fromPartition(accountPartition(site.id, account.id))
  if (deps.proxy) {
    try {
      await ses.setProxy({ proxyRules: deps.proxy })
    } catch {
      // 代理设置失败仍继续，加载阶段会如实报错
    }
  }

  // 把已保存的会话灌进分区（分区可能因清理而空）
  if (account.cookie) {
    for (const part of account.cookie.split(';')) {
      const idx = part.indexOf('=')
      if (idx <= 0) continue
      try {
        await ses.cookies.set({
          url: site.baseUrl,
          name: part.slice(0, idx).trim(),
          value: part.slice(idx + 1).trim()
        })
      } catch {
        // 单个 cookie 写不进去不影响其余
      }
    }
  }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    skipTaskbar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })

  const deadline = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: '静默重登超时' }), 45_000)
  })

  const work = (async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await win.loadURL(`${site.baseUrl.replace(/\/+$/, '')}/console`)
    } catch {
      // /console 不存在时退回首页
      try {
        await win.loadURL(site.baseUrl)
      } catch (e) {
        return { ok: false, error: `页面加载失败：${e instanceof Error ? e.message : String(e)}` }
      }
    }
    await new Promise((r) => setTimeout(r, 2500))

    const current = win.webContents.getURL()
    // 落到登录页 = 分区里没有有效会话，需要人工授权
    if (/\/(sign-?in|login)(\?|$)/i.test(current)) {
      return { ok: false, error: '分区内会话已失效，需要重新授权' }
    }
    return { ok: true }
  })()

  const result = await Promise.race([work, deadline])

  // 无论成败都取回最新的分区 Cookie：站点可能在此期间刷新了会话
  let cookie: string | undefined
  try {
    const list = await ses.cookies.get({ url: site.baseUrl })
    cookie = list.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    cookie = undefined
  }

  try {
    win.destroy()
  } catch {
    // 窗口可能已被回收
  }

  return { ...result, cookie }
}

/**
 * 执行重登签到。
 *
 * 流程：余额基线 → 登出 → 隐藏窗口重登 → 余额复核 → 增量达标才认为到账。
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

  // 1) 余额基线
  const before = await deps.readBalance(false)
  deps.log('info', '重登签到开始', `签到前余额=${before ?? '未知'}`)

  // 2) 登出：真实服务端注销，确保随后的登录会触发放额度
  const loggedOut = await deps.logout()
  deps.log(loggedOut ? 'info' : 'warn', loggedOut ? '登出已确认' : '登出未确认')

  // 3) 隐藏窗口重登
  const relogin = await silentRelogin(site, account, deps)
  if (!relogin.ok) {
    deps.log('warn', '静默重登未完成', relogin.error)
    return {
      ok: false,
      already: false,
      needVisible: true,
      message: `需要在应用内重新登录：${relogin.error ?? '未知原因'}`
    }
  }
  if (relogin.cookie) {
    await deps.session.onRenewed(account.id, { cookie: relogin.cookie })
  }

  // 4) 补发 sign_in（尽力而为，不作为判据）
  try {
    const paths = selfPaths('NEWAPI', site.baseUrl)
    void paths
    await send(`${site.baseUrl.replace(/\/+$/, '')}/api/user/sign_in`, {
      method: 'POST',
      headers: {
        ...authHeaders(account.token, account.siteUserId),
        'Content-Type': 'application/json'
      },
      body: '{}',
      proxy: deps.proxy,
      cookie: relogin.cookie ?? account.cookie,
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
