import type {
  Account,
  CheckinMode,
  CheckinReceipt,
  QuotaSnapshot,
  Site,
  SiteKind
} from '../../shared/types'
import { authHeaders, parseJson, send, wafBlocked } from '../net/httpClient'
import { acquireTurnstileToken } from './turnstile'
import { requestWithHealing } from './session'
import type { SessionDeps } from './session'
import {
  balanceFields,
  checkinActionPath,
  checkedInThisPeriod,
  isAnyRouter,
  kindOf,
  rewardDate,
  rewardEpochMs,
  selfPaths,
  usedFields
} from './profile'

/**
 * 站点业务引擎：读额度、读签到状态、执行签到。
 *
 * 设计约束（全部来自上游踩坑总结）：
 *   1. 字段认不出就如实报「未知」，绝不编造数字
 *   2. 端点 404 绝不标记已签
 *   3. 只有拿到可验证的到账证据才写签到回执
 *   4. 刷新与签到不得隐式触发 OAuth
 *   5. 刷新与签到都要跟站点核对：登录即发放型站点以「今日签到记录 /
 *      今日系统奖励日志」为最终判据，本地回执只是缓存，不是唯一事实
 */

export interface EngineDeps {
  proxy: string
  /** 站点 Turnstile sitekey；站点未开启人机验证时为空。 */
  turnstileSiteKey?: string
  /** 会话自愈依赖；不提供时退化为单次请求（无续期）。 */
  session?: SessionDeps
}

/**
 * New API 配额单位：默认 500000 quota = $1。
 * 站点可在 /api/status 里用 quota_per_unit 覆盖，因此换算时要按站点实际值。
 */
const QUOTA_PER_UNIT = 500_000

/** 取站点实际使用的配额单位；站点没给或给了非法值时退回默认值。 */
export function unitOf(site: Pick<Site, 'quotaPerUnit'>): number {
  const u = site.quotaPerUnit
  return typeof u === 'number' && Number.isFinite(u) && u > 0 ? u : QUOTA_PER_UNIT
}

/**
 * 把原始 quota 折算成美元。
 *
 * 签到记录的 `quota_awarded` 是 quota 单位（10000000 = $20），
 * 但个别站点/字段直接给美元（如 25 表示 $25）。上游用 `q >= 1000` 区分：
 * 小于 1000 的值不可能是 scaled quota（那样连 $0.01 都不到），按美元处理。
 * 不加这条判断会把 $25 错算成 $0.00005，也会把 10000000 直接显示成 1000 万。
 */
export function quotaToUsd(quota: number | undefined, unit = QUOTA_PER_UNIT): number | undefined {
  if (quota === undefined) return undefined
  if (quota > 0 && quota < 1000) return quota
  return Math.round((quota / unit) * 10000) / 10000
}

/**
 * 余额字段的换算：严格按站点单位折算，不做「小值当美元」的猜测。
 *
 * 小值保护是给**奖励**字段准备的（有的站点 direct 给美元）。
 * 用到余额上会出事：余额 quota=500（=$0.001）会被当成 $500 显示。
 * 余额本身一定是 quota 单位，按单位换算即可。
 */
export function quotaToUsdExact(quota: number | undefined, unit = QUOTA_PER_UNIT): number | undefined {
  if (quota === undefined) return undefined
  return Math.round((quota / unit) * 10000) / 10000
}

/**
 * 美元金额合理性上限。
 *
 * 签到奖励是个位数到几十美元的量级。换算结果一旦超过这个上限，
 * 说明拿到的其实是 quota 原始值（例如单位取错、或字段本身已是 quota），
 * 界面上就会冒出「+$1036.99」这种数字 —— 用户说的「一堆不对的数据」。
 * 遇到这种情况宁可显示「金额未知」，也不展示一个明显错误的数。
 */
const MAX_PLAUSIBLE_REWARD_USD = 1000

export function plausibleReward(v: number | undefined): number | undefined {
  if (v === undefined) return undefined
  if (!Number.isFinite(v) || v < 0 || v >= MAX_PLAUSIBLE_REWARD_USD) return undefined
  return v
}

/** 金额展示统一保留两位小数，避免出现 29.357124 这种尾巴。 */
function roundUsd(v: number | undefined): number | undefined {
  if (v === undefined) return undefined
  return Math.round(v * 100) / 100
}

function finite(obj: Record<string, unknown> | null | undefined, keys: string[]): number | undefined {
  if (!obj) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (v === null || v === undefined) continue
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** 从 /api/user/self 响应中取用户对象，兼容多层包裹。 */
function selfUser(payload: unknown): Record<string, unknown> | null {
  const root = payload as Record<string, unknown> | null
  if (!root) return null
  const envelope = root.data as Record<string, unknown> | undefined
  if (!envelope) return null
  const inner = (envelope.data as Record<string, unknown> | undefined) ?? envelope
  const user = inner.user as Record<string, unknown> | undefined
  return user ?? inner
}

/** 读取账号当前额度与签到状态。 */
export async function readStatus(
  site: Site,
  account: Account,
  deps: EngineDeps
): Promise<QuotaSnapshot> {
  const kind = kindOf(site)
  const now = Date.now()

  // 走自愈通道：401 时用 refresh cookie 续期并重试，503 抖动廉价重试
  const healing = deps.session
  const attempt = async (
    path: string
  ): Promise<{ status: number; body: string } | { error: string }> => {
    try {
      if (healing) {
        const r = await requestWithHealing(
          site,
          deps.session!.readAccount(account.id) ?? account,
          'GET',
          path,
          healing
        )
        return { status: r.status, body: r.body }
      }
      const res = await send(`${site.baseUrl.replace(/\/+$/, '')}${path}`, {
        proxy: deps.proxy,
        cookie: account.cookie,
        headers: authHeaders(account.token, account.siteUserId),
        timeoutMs: 20_000
      })
      return { status: res.status, body: res.body }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  for (const path of selfPaths(kind, site.baseUrl)) {
    const res = await attempt(path)
    if ('error' in res) {
      return { at: now, ok: false, error: res.error }
    }

    if (res.status === 404 || res.status === 405) continue
    if (res.status === 401 || res.status === 403) {
      return { at: now, ok: false, error: '会话已失效，需要重新授权' }
    }
    if (res.status === 409) {
      return { at: now, ok: false, error: '站点会话数已达上限，请到站点端退出多余设备' }
    }
    if (res.status !== 200) {
      return { at: now, ok: false, error: `HTTP ${res.status}` }
    }

    // 防护页优先判断：它同样返回 200，但正文是 HTML。
    // 先看这个，才不会把「节点被风控」误报成「站点协议变了」。
    if (wafBlocked(res.body)) {
      return {
        at: now,
        ok: false,
        error: '站点防护拦截（当前代理节点被风控），请更换节点后重试'
      }
    }

    const json = parseJson(res.body)
    const user = selfUser(json)
    if (!user) {
      // 响应是 HTML 而不是 JSON：几乎都是站点被电信/云厂商换成了维护页或验证页
      const looksHtml = /^\s*<(!doctype|html)/i.test(res.body)
      return {
        at: now,
        ok: false,
        error: looksHtml
          ? '站点返回了网页而不是数据（可能被防护拦截或维护中），请更换节点或稍后重试'
          : '响应结构无法识别'
      }
    }

    const available = finite(user, balanceFields(kind))
    const usedRaw = finite(user, usedFields(kind))
    const unit = unitOf(site)
    // 余额一定是 quota 单位：严格按单位折算，不能套用奖励字段的「小值当美元」保护。
    // 否则余额 500（=$0.001）会被显示成 $500，界面就出现一堆对不上的数字。
    const availableUsd =
      kind === 'NEWAPI' ? quotaToUsdExact(available, unit) : available
    const usedUsd = kind === 'NEWAPI' ? quotaToUsdExact(usedRaw, unit) : usedRaw

    const checkedLocal = checkedInThisPeriod(account.lastCheckin, now)
    let checkedToday = checkedLocal
    let siteChecked: boolean | undefined
    let siteReward: number | undefined
    let checkinSource: string | undefined
    if (!checkedLocal) {
      // 本地无回执不等于没签：向站点核对今日签到记录（登录即发放型站点的最终判据）
      const recon = await reconcileCheckin(site, account, deps)
      if (recon.checked) {
        checkedToday = true
        siteChecked = true
        siteReward = recon.reward
        checkinSource = recon.source
      }
    }

    return {
      at: now,
      ok: true,
      available: availableUsd,
      used: usedUsd,
      checkedToday,
      siteChecked,
      siteReward,
      checkinSource,
      error: undefined
    }
  }

  return { at: now, ok: false, error: '未找到可用的会话端点' }
}

/** 从 self 响应中取站点用户 ID，供登录后首次落库。 */
export async function fetchSiteUserId(
  site: Site,
  account: Account,
  deps: EngineDeps
): Promise<string | undefined> {
  const base = site.baseUrl.replace(/\/+$/, '')
  const kind = kindOf(site)
  for (const path of selfPaths(kind, base)) {
    try {
      const res = await send(`${base}${path}`, {
        proxy: deps.proxy,
        cookie: account.cookie,
        headers: authHeaders(account.token, account.siteUserId),
        timeoutMs: 15_000
      })
      if (res.status === 200) {
        const user = selfUser(parseJson(res.body))
        if (user?.id !== undefined && user.id !== null) return String(user.id)
      }
    } catch {
      // 忽略，继续下一个候选端点
    }
  }
  return undefined
}

/** 只读签到状态：GET /api/user/checkin 或福利站 /api/checkin/status。 */
export async function readCheckinState(
  site: Site,
  account: Account,
  deps: EngineDeps
): Promise<{ known: boolean; checkedToday: boolean; reward?: number; error?: string }> {
  const kind = kindOf(site)
  const base = site.baseUrl.replace(/\/+$/, '')
  const headers = authHeaders(account.token, account.siteUserId)
  const month = rewardDate(Date.now()).slice(0, 7)

  const url =
    kind === 'WELFARE'
      ? `${base}/api/checkin/status`
      : `${base}/api/user/checkin?month=${month}`

  try {
    const res = await send(url, {
      proxy: deps.proxy,
      cookie: account.cookie,
      headers,
      timeoutMs: 15_000
    })
    if (res.status === 404) return { known: false, checkedToday: false, error: '站点无签到状态接口' }
    if (res.status !== 200) return { known: false, checkedToday: false, error: `HTTP ${res.status}` }
    const json = parseJson<Record<string, unknown>>(res.body)
    const data = (json?.data as Record<string, unknown> | undefined) ?? json ?? undefined
    if (!data) return { known: false, checkedToday: false, error: '响应无法解析' }

    if (kind === 'WELFARE') {
      return {
        known: true,
        checkedToday: data.checked_in_today === true,
        reward: plausibleReward(roundUsd(finite(data, ['reward', 'amount', 'quota_awarded'])))
      }
    }

    const stats = data.stats as Record<string, unknown> | undefined
    // checked_in_today 布尔可能因站点缓存/时区滞后失真，当月记录按日期比对才可靠（上游做法）
    const today = rewardDate(Date.now())
    const records = (stats?.records ?? data.records ?? []) as Array<Record<string, unknown>>
    // 接口按时间倒序，命中第一条今日记录即最新一条
    const rec = records.find((o) => String(o?.checkin_date ?? o?.date ?? '') === today)
    const checkedToday =
      stats?.checked_in_today === true || data.checked_in_today === true || !!rec
    // quota_awarded 是 quota 单位，必须先折成美元再展示
    const rewardRaw = (rec && finite(rec, ['quota_awarded', 'reward'])) ?? finite(stats ?? data, ['quota_awarded', 'reward'])
    const reward = plausibleReward(roundUsd(quotaToUsd(rewardRaw, unitOf(site))))
    return { known: true, checkedToday, reward }
  } catch (e) {
    return {
      known: false,
      checkedToday: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/**
 * 纯函数：从 /api/log/self 的流水里找「今日签到」记录（便于单测）。
 *
 * 移植自上游 CheckinJs.todayBonusLog / Engine.todayBonus：
 *   - 只认文案含「签到 / check-in」的条目；同为 type=4 的注册、邀请、兑换赠送要排除
 *   - 时间戳必须落在当前奖励周期（北京日界）内
 *   - 接口按时间倒序，命中第一条（最新）即停，不取最旧记录
 *   - 条目 quota 字段恒为 0，金额只写在文案里（「…增加额度 $25.0000000 额度」）
 */
export function matchTodayCheckinLog(
  items: unknown,
  nowMs: number
): { found: boolean; reward?: number; known: boolean } {
  const list = Array.isArray(items) ? items : []
  const s0 = Math.floor(rewardEpochMs(nowMs) / 1000)
  const e0 = s0 + 86_400
  for (const raw of list) {
    const o = raw as Record<string, unknown> | null
    if (!o || typeof o !== 'object') continue
    const txt = String(o.content ?? o.description ?? o.remark ?? o.message ?? '')
    if (!/签到|check.?in/i.test(txt)) continue
    if (/注册|邀请|兑换/.test(txt)) continue
    let ts = Number(o.created_at ?? o.createdAt ?? o.timestamp ?? o.created_time ?? 0)
    if (ts > 0) {
      if (ts > 1e12) ts = Math.floor(ts / 1000)
      if (ts < s0 || ts >= e0) continue
    }
    const mm = txt.match(/[＄$]\s*([0-9]+(?:\.[0-9]+)?)/)
    return mm
      ? { found: true, reward: Math.round(Number(mm[1]) * 100) / 100, known: true }
      : { found: true, known: false }
  }
  return { found: false, known: false }
}

/**
 * 纯函数：从 /api/log/self 的流水里找「今日系统到账」，作为签到文案未命中时的兜底。
 *
 * 登录即发放型站点（AgentRouter 等）的到账文案不一定含「签到」二字，
 * 只按关键字匹配会漏判；漏判之后就只能退回「余额增量」，而增量里混着
 * 同时段的消耗，每天都不一样 —— 界面上就成了 $20.90、$21.71 这种噪声。
 *
 * 判据（与上游一致）：
 *   - type=4 的系统类流水
 *   - 时间戳落在当前奖励周期（北京日界）内
 *   - 有正额度：quota > 0 或文案里有正金额
 *   - 排除一次性赠送（注册 / 邀请 / 兑换）与消耗类流水（消耗 / 使用 / 扣费 / 退款）：
 *     它们同样带金额，但都不是签到发放，误判会把当天变成「已签」而漏签
 * 接口按时间倒序，命中第一条（最新）即停。
 */
export function matchTodayCreditLog(
  items: unknown,
  nowMs: number
): { found: boolean; reward?: number; known: boolean } {
  const list = Array.isArray(items) ? items : []
  const s0 = Math.floor(rewardEpochMs(nowMs) / 1000)
  const e0 = s0 + 86_400
  for (const raw of list) {
    const o = raw as Record<string, unknown> | null
    if (!o || typeof o !== 'object') continue
    const type = Number(o.type ?? o.log_type ?? 0)
    if (Number.isFinite(type) && type !== 0 && type !== 4) continue
    const txt = String(o.content ?? o.description ?? o.remark ?? o.message ?? '')
    if (/注册|邀请|兑换|充值|消耗|使用|扣费|退款|退订/.test(txt)) continue
    let ts = Number(o.created_at ?? o.createdAt ?? o.timestamp ?? o.created_time ?? 0)
    if (ts > 1e12) ts = Math.floor(ts / 1000)
    if (!(ts > 0) || ts < s0 || ts >= e0) continue

    const quota = finite(o, ['quota'])
    // 文案里的金额才是可信的：签到条目的 quota 字段常为 0
    const mm = txt.match(/[＄$]\s*([0-9]+(?:\.[0-9]+)?)/)
    if (mm) {
      const v = Math.round(Number(mm[1]) * 100) / 100
      return { found: true, reward: plausibleReward(v), known: true }
    }
    if (quota !== undefined && quota > 0) {
      return { found: true, reward: plausibleReward(roundUsd(quotaToUsd(quota))), known: true }
    }
    // 显然是一次系统事件但读不出金额：命中，但不编造数字
    return { found: true, known: false }
  }
  return { found: false, known: false }
}

/**
 * 只读奖励流水：GET /api/log/self?type=4（系统类），退化为全量最近 50 条。
 *
 * @param creditFallback 允许退到「今日系统到账」兜底。只对登录即发放型站点开启：
 *   这类站点没有签到端点，到账文案也不含「签到」二字。BUTTON 站点必须关掉，
 *   否则一次充值或赠送都会被误判成「今日已签」，反而漏签。
 */
export async function readTodayBonusLog(
  site: Site,
  account: Account,
  deps: EngineDeps,
  creditFallback = false
): Promise<{ found: boolean; reward?: number; known: boolean }> {
  if (kindOf(site) !== 'NEWAPI') return { found: false, known: false }
  const base = site.baseUrl.replace(/\/+$/, '')
  const headers = authHeaders(account.token, account.siteUserId)
  const paths = ['/api/log/self?type=4&limit=30&page=1', '/api/log/self?limit=50&page=1']
  for (const path of paths) {
    try {
      const res = await send(`${base}${path}`, {
        proxy: deps.proxy,
        cookie: account.cookie,
        headers,
        timeoutMs: 15_000
      })
      if (res.status !== 200) continue
      const json = parseJson<Record<string, unknown>>(res.body)
      if (!json || json.success === false) continue
      const items = pickLogItems(json)
      // 先认明确的「签到」文案（最准），没有再退到「今日系统到账」兜底
      const hit = matchTodayCheckinLog(items, Date.now())
      if (hit.found) return hit
      if (creditFallback) {
        const credit = matchTodayCreditLog(items, Date.now())
        if (credit.found) return credit
      }
    } catch {
      // 单个端点失败继续下一个；都失败则如实返回未命中
    }
  }
  return { found: false, known: false }
}

/** 从各种嵌套形态里取出流水条目数组。 */
export function pickLogItems(json: Record<string, unknown>): unknown[] {
  const d = json.data as Record<string, unknown> | unknown[] | undefined
  const wrap = (Array.isArray(d) ? undefined : d) as Record<string, unknown> | undefined
  if (Array.isArray(d)) return d
  for (const key of ['items', 'data', 'logs', 'records'] as const) {
    const v = wrap?.[key]
    if (Array.isArray(v)) return v
  }
  return []
}

export interface ReconcileResult {
  checked: boolean
  reward?: number
  /** 命中来源，写日志与回执用。 */
  source?: string
}

/**
 * 与站点核对「今日是否已签」：先查签到状态（含当月记录），再查今日系统奖励日志。
 * 登录即发放型站点（AgentRouter 等）的签到状态接口有时不回写，日志是最终判据。
 */
export async function reconcileCheckin(
  site: Site,
  account: Account,
  deps: EngineDeps
): Promise<ReconcileResult> {
  const state = await readCheckinState(site, account, deps)
  if (state.known && state.checkedToday) {
    return { checked: true, reward: state.reward, source: '服务端签到记录' }
  }
  // 只有「没有签到端点 / 登录即发放」的站点才允许把「今日系统到账」当成签到证据。
  // BUTTON 站点误用这条兜底，会把一次充值或赠送判成已签，从而漏签。
  const log = await readTodayBonusLog(site, account, deps, site.mode !== 'BUTTON')
  if (log.found) {
    return { checked: true, reward: log.reward, source: '站点日志今日签到记录' }
  }
  return { checked: false }
}

export interface CheckinResult {
  ok: boolean
  already: boolean
  reward?: number
  message: string
  receipt?: CheckinReceipt
}

/**
 * 执行签到。
 *
 * BUTTON：先查状态，已签直接返回；未签才 POST。
 * RELOGIN（agentrouter / anyrouter）：没有签到端点，当日额度由登录动作发放，
 *   因此这里如实返回「需要在应用内重新登录」，不伪造成功。
 * LOGIN_GRANT：登录即得，只核验当日回执，不发请求。
 * WEB_ONLY：明确告知需人工处理。
 */
export async function checkin(
  site: Site,
  account: Account,
  deps: EngineDeps
): Promise<CheckinResult> {
  const mode: CheckinMode = site.mode
  const now = Date.now()

  if (checkedInThisPeriod(account.lastCheckin, now)) {
    return { ok: true, already: true, message: '今日已签到' }
  }

  if (mode === 'WEB_ONLY') {
    return { ok: false, already: false, message: '该站点仅支持网页手动签到' }
  }

  if (mode === 'LOGIN_GRANT') {
    // 登录即得：先跟站点核对，今日已有发放就如实报已签；
    // 没有才提示去刷新（这类站点靠登录动作发放，签到端点本身不存在）
    const recon = await reconcileCheckin(site, account, deps)
    if (recon.checked) {
      const reward = plausibleReward(recon.reward)
      const receipt: CheckinReceipt = {
        at: now,
        date: rewardDate(now),
        ok: true,
        already: true,
        reward,
        rewardSource: 'site',
        message: '今日已签到'
      }
      return { ok: true, already: true, reward, message: receipt.message, receipt }
    }
    return {
      ok: false,
      already: false,
      message: '该站点为登录即发放额度，请刷新额度确认到账'
    }
  }

  if (mode === 'RELOGIN') {
    return {
      ok: false,
      already: false,
      message: isAnyRouter(site.baseUrl)
        ? '该站点需重新登录才发放当日额度'
        : '该站点需重新登录才发放当日额度'
    }
  }

  // BUTTON：先跟站点核对，避免在「今日已签」时白撞一次人机验证
  const recon = await reconcileCheckin(site, account, deps)
  if (recon.checked) {
    const receipt: CheckinReceipt = {
      at: now,
      date: rewardDate(now),
      ok: true,
      already: true,
      reward: plausibleReward(recon.reward),
      rewardSource: 'site',
      message: '今日已签到'
    }
    return { ok: true, already: true, reward: receipt.reward, message: receipt.message, receipt }
  }

  const kind: SiteKind = kindOf(site)
  const path = checkinActionPath(site)
  if (!path) {
    return { ok: false, already: false, message: '该站点没有可用的签到端点' }
  }

  const base = site.baseUrl.replace(/\/+$/, '')
  const headers = {
    ...authHeaders(account.token, account.siteUserId),
    'Content-Type': 'application/json'
  }

  const post = async (url: string, extraHeaders: Record<string, string> = {}) => {
    // 签到 POST 不重放：只做「401 时续期后重试一次」，绝不做抖动重试
    const res = await send(url, {
      method: 'POST',
      headers: { ...headers, ...extraHeaders },
      body: '{}',
      proxy: deps.proxy,
      cookie: deps.session?.readAccount(account.id)?.cookie ?? account.cookie,
      timeoutMs: 25_000
    })
    return res
  }

  const interpret = (
    res: { status: number; body: string },
    rewardUnit: boolean
  ): CheckinResult => {
    const json = parseJson<Record<string, unknown>>(res.body)
    const success = json?.success === true || json?.code === 0
    const message =
      (typeof json?.message === 'string' && json.message) ||
      (typeof json?.error === 'string' && json.error) ||
      `HTTP ${res.status}`

    if (res.status === 401 || /未登录|请先登录|AUTH_TOKEN|无权|unauthorized/i.test(message)) {
      return { ok: false, already: false, message: '授权已过期，请重新登录该账号' }
    }
    if (res.status === 429) {
      return { ok: false, already: false, message: '站点限流（429），代理节点可能被拦，请更换节点' }
    }
    // 已有今日记录的语义：视为已签，不是失败
    if (!success && /已签|已领|重复|already|签到过|checked.?in/i.test(message)) {
      return { ok: true, already: true, message: '今日已签到' }
    }
    if (!success) {
      if (/turnstile|captcha|人机|验证|challenge|robot/i.test(message)) {
        return { ok: false, already: false, message: `人机验证未通过：${message}` }
      }
      return { ok: false, already: false, message }
    }

    const data = json?.data as Record<string, unknown> | undefined
    const reward = finite(data, ['quota_awarded', 'reward', 'quota'])
    // quota_awarded 是 quota 单位；reward/quota 若是直接金额，quotaToUsd 的小值保护会原样返回
    const rewardUsd =
      rewardUnit && kind === 'NEWAPI' ? plausibleReward(roundUsd(quotaToUsd(reward, unitOf(site)))) : plausibleReward(reward)

    const receipt: CheckinReceipt = {
      at: now,
      date: rewardDate(now),
      ok: true,
      already: false,
      reward: rewardUsd,
      rewardSource: 'site',
      message
    }
    return { ok: true, already: false, reward: rewardUsd, message, receipt }
  }

  let res: { status: number; body: string }
  try {
    // 福利站：POST /api/checkin 且必须带 X-Turnstile-Token
    if (kind === 'WELFARE') {
      const tokenRes = await acquireTurnstileToken(
        base,
        deps.turnstileSiteKey ?? '',
        account.cookie,
        `${site.id}|${account.id}`,
        deps.proxy
      )
      if (!tokenRes.ok || !tokenRes.token) {
        return { ok: false, already: false, message: tokenRes.error ?? '人机验证失败' }
      }
      res = await post(`${base}${path}`, { 'X-Turnstile-Token': tokenRes.token })
      return interpret(res, false)
    }

    // New API：先直接签到
    res = await post(`${base}${path}`)
    const first = interpret(res, true)
    // 只有明确「需要人机验证」才去取 token，其余情况不白跑一次隐藏窗口
    const needsTurnstile =
      !first.ok && (/turnstile|captcha|人机|验证/i.test(first.message) || res.status === 403)

    if (!needsTurnstile) return first

    // 站点开启了 Turnstile，或首次被要求验证：取 token 后重试一次
    const sitekey = deps.turnstileSiteKey ?? ''
    if (!sitekey) {
      return { ok: false, already: false, message: '需要人机验证，但站点未返回 sitekey' }
    }
    const tokenRes = await acquireTurnstileToken(
      base,
      sitekey,
      account.cookie,
      `${site.id}|${account.id}`,
      deps.proxy
    )
    if (!tokenRes.ok || !tokenRes.token) {
      // 验证未通过时，回到站点核对一次：可能其实已签（登录即发放）
      const recheck = await reconcileCheckin(site, account, deps)
      if (recheck.checked) {
        return {
          ok: true,
          already: true,
          reward: plausibleReward(recheck.reward),
          message: '今日已签到',
          receipt: {
            at: now,
            date: rewardDate(now),
            ok: true,
            already: true,
            reward: plausibleReward(recheck.reward),
            rewardSource: 'site',
            message: '今日已签到'
          }
        }
      }
      return { ok: false, already: false, message: tokenRes.error ?? '人机验证失败' }
    }

    // New API 的约定是把 token 放在 query 上（不是 header）
    res = await post(`${base}${path}?turnstile=${encodeURIComponent(tokenRes.token)}`)
    return interpret(res, true)
  } catch (e) {
    return {
      ok: false,
      already: false,
      message: e instanceof Error ? e.message : String(e)
    }
  }
}
