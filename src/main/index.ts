import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  shell,
  Tray
} from 'electron'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ConfigStore } from './store'
import { resolveProxy, probeProxy } from './net/proxy'
import { catalogById, siteFromCatalog } from '../shared/catalog'
import { IPC } from '../shared/ipc'
import type { CheckinResultDto, StatusResultDto, AccountResultDto } from '../shared/ipc'
import type {
  Account,
  AuthProvider,
  CheckinReceipt,
  ProxySettings,
  PublicCredential,
  QuotaSnapshot,
  Settings,
  Site,
  SiteProbeResult
} from '../shared/types'
import { probeSite } from './sites/probe'
import { checkin, planCheckin, readStatus, reconcileCheckin } from './sites/engine'
import { runOAuth } from './sites/oauth'
import { acquireTurnstileToken } from './sites/turnstile'
import { reloginCheckin } from './sites/relogin'
import { logoutSession } from './sites/logout'
import { isSessionExpired, rebuildSession, reloginCapability } from './sites/reloginSession'
import {
  ensureProviderSession,
  hasProviderSession,
  silentReauth,
  snapshotProviderSession
} from './sites/silentReauth'
import { parseProviderCookies } from './sites/providerSession'
import { startKeepAlive } from './sites/keepAlive'
import { migrateAccountPartition } from './sites/partitionMigrate'
import { readApiKeys } from './sites/tokens'
import { getSiteIcon } from './sites/favicon'
import { checkedInThisPeriod, needsRewardEnrichment, rewardDate } from './sites/profile'
import { isUsableTotpSecret, secondsRemaining, totp } from './auth/totp'
import { accountFromPasswordLogin, passwordLogin } from './auth/passwordLogin'
import type { SessionDeps } from './sites/session'
import { randomUUID } from 'node:crypto'
import { sanitizeWindowBounds } from './windowBounds'
import { WindowStateStore } from './windowState'
import {
  appVersion,
  checkForUpdates,
  getUpdateStatus,
  initUpdater,
  onUpdateStatus,
  openDownloadPage,
  quitAndInstall,
  updaterAvailable
} from './updater'
import { releasePageUrl, repoHomeUrl } from './updatePolicy'

/**
 * 必须在读取任何 app 路径之前设置应用名。
 *
 * 开发模式下 Electron 默认取 package.json 的 name（autosign-desktop），
 * 但直接用 electron 二进制运行脚本时它会是 "Electron" —— 与其它 Electron
 * 项目共用同一份 userData，配置会互相覆盖。打包后 productName 才生效，
 * 届时路径又变，配置看起来像"丢了"。统一在这里钉死，三种运行方式一致。
 */
app.setName('AutoSign')
// 开发时仍然保留独立目录，避免与已安装版本抢配置。
// 但命令行显式传了 --user-data-dir 时必须以它为准（测试与多开隔离依赖这一点），
// 否则会覆盖掉调用方指定的目录，导致不同测试实例共写同一份配置。
const hasExplicitUserData = process.argv.some((a) => a.startsWith('--user-data-dir'))
if (!app.isPackaged && !hasExplicitUserData) {
  app.setPath('userData', join(app.getPath('appData'), 'AutoSign-Dev'))
}

/**
 * 主进程入口。
 *
 * 职责边界：
 *   - 所有网络访问与凭据操作只在这里发生
 *   - 渲染进程只收发结构化数据，拿不到 Node 能力
 *   - 后台定时签到由一个进程内的调度器驱动（不依赖渲染进程存活）
 */

const store = new ConfigStore()
const windowState = new WindowStateStore()
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 只有托盘菜单的「退出」（或系统退出流程）才允许真正关闭窗口。 */
let quitting = false
/** 「已最小化到托盘」的提示每次运行只弹一次。 */
let trayHintShown = false

/** 界面主题同步到原生层：滚动条、菜单等原生控件跟随深浅色。 */
function applyNativeTheme(): void {
  nativeTheme.themeSource = store.getSettings().theme ?? 'dark'
  applyTitleBarOverlay()
}

/** 窗口初始背景色与主题一致，避免启动瞬间闪色。 */
function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#1a1a1e' : '#f4f4f6'
}

/** Windows 窗口控制覆叠配色：与标题条同底，符号色跟随主题文字。 */
function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors
  return {
    color: dark ? '#1a1a1e' : '#f4f4f6',
    symbolColor: dark ? '#b9b9c1' : '#4b4b53',
    height: 44
  }
}

/** 主题变化时同步覆叠配色，否则亮色主题下右上角会剩一块深色底。 */
function applyTitleBarOverlay(): void {
  if (process.platform !== 'win32') return
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitleBarOverlay(titleBarOverlay())
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function currentProxy(): Promise<string> {
  const settings = store.getSettings()
  const { url } = await resolveProxy(settings.proxy)
  return url
}

function siteOf(accountId: string): { site: Site; account: Account } | undefined {
  const config = store.getInternal()
  for (const site of config.sites) {
    const account = site.accounts.find((a) => a.id === accountId)
    if (account) return { site, account }
  }
  return undefined
}

/** 落库账号的临时状态（额度/回执），避免整对象覆盖丢字段。 */
async function patchAccount(accountId: string, patch: Partial<Account>): Promise<void> {
  await store.mutate((config) => {
    for (const site of config.sites) {
      const idx = site.accounts.findIndex((a) => a.id === accountId)
      if (idx >= 0) {
        site.accounts[idx] = { ...site.accounts[idx], ...patch }
        return
      }
    }
  })
}

/** 凭据的对外视图：抹掉密码与 TOTP 原文，只保留「是否已保存」。 */function publicCredentials(): PublicCredential[] {
  return store.get().credentials.map((c) => ({
    id: c.id,
    provider: c.provider,
    username: c.username,
    displayName: c.displayName,
    note: c.note,
    hasPassword: !!c.password,
    hasTotp: !!c.totpSecret,
    lastUsedAt: c.lastUsedAt,
    createdAt: c.createdAt
  }))
}

function providerLabelOf(p: AuthProvider): string {
  if (p === 'linuxdo') return 'Linux DO'
  if (p === 'password') return '邮箱/密码'
  return 'GitHub'
}

/** 会话自愈依赖：续期结果写回账号，日志带站点与账号上下文。 */
function sessionDeps(siteId: string, accountId: string, proxy: string): SessionDeps {
  return {
    proxy,
    onRenewed: async (id, patch) => {
      // 续期会轮换 refresh cookie，必须原子回写，否则下次续期用旧值必然失败
      await patchAccount(id, patch)
    },
    readAccount: (id) => store.findAccount(id),
    log: (level, message, detail) => store.log(level, '会话续期', message, { siteId, accountId, detail })
  }
}

/**
 * 把站点核对到的今日签到信息写回回执。
 *
 * 两种用途：
 *   1. 本地没有回执、但站点已有今日记录（登录即发放型站点的额度由登录动作发放，
 *      本地重登流程看不到这笔钱）→ 补记一条回执，否则徽章一直显示「未签」。
 *   2. 本地有回执、但金额不可信（历史「余额增量」）或缺失 → 用站点记录里的
 *      真实金额替换，让金额重新显示出来；读不到就保持空白，绝不拿增量凑数。
 *
 * 无论哪种都会记下 rewardCheckedAt，避免下次刷新又立刻向站点问一遍。
 */
async function syncCheckinReceipt(site: Site, accountId: string, snapshot: QuotaSnapshot): Promise<void> {
  // rewardChecked 表示这次读数确实向站点核对过；没有核对就什么都不用做
  if (!snapshot.ok || !snapshot.rewardChecked) return
  const account = store.findAccount(accountId)
  if (!account) return
  const now = Date.now()
  const existing = account.lastCheckin
  const localToday = checkedInThisPeriod(existing, now)
  const reward = snapshot.siteReward

  // 核对没有命中站点记录：只记下这次尝试的时间。
  // 不记的话，金额缺失的账号每次刷新都会再打两个请求，而结果不会变。
  if (!snapshot.siteChecked) {
    if (localToday && existing && existing.rewardCheckedAt === undefined) {
      await patchAccount(accountId, { lastCheckin: { ...existing, rewardCheckedAt: now } })
    }
    return
  }

  if (localToday && existing) {
    // 已有今日回执：只补/换金额，不动 at 与 already，保留原始签到时间与语义
    if (existing.rewardSource === 'site' && existing.reward !== undefined) return
    if (reward === undefined && existing.rewardSource === 'site') return
    const next: CheckinReceipt = {
      ...existing,
      ...(reward !== undefined ? { reward, rewardSource: 'site' as const } : {}),
      rewardCheckedAt: now
    }
    // 站点确实没有金额：把来源从「余额增量」改成「站点记录」，界面就不必再猜
    if (reward === undefined) {
      next.reward = undefined
      next.rewardSource = 'site'
    }
    await patchAccount(accountId, { lastCheckin: next })
    if (reward !== undefined) {
      store.log('ok', '签到核对', `${site.name} / ${account.label}：已从站点记录补全签到金额 +$${reward}`, {
        siteId: site.id,
        accountId
      })
    }
    return
  }

  const receipt: CheckinReceipt = {
    at: now,
    date: rewardDate(now),
    ok: true,
    already: true,
    reward,
    rewardSource: 'site',
    rewardCheckedAt: now,
    message: `站点核对：${snapshot.checkinSource ?? '今日签到记录'}`
  }
  await patchAccount(accountId, { lastCheckin: receipt })
  store.log(
    'ok',
    '签到核对',
    `${site.name} / ${account.label}：站点已有今日签到记录，补记回执${
      reward !== undefined ? `（+$${reward}）` : ''
    }`,
    { siteId: site.id, accountId }
  )
}

/**
 * 会话失效时用绑定凭据自动重建，并落库新会话。
 *
 * 密码类凭据直接登录；GitHub / Linux DO 先试静默重授权，分区登录态没了
 * 但凭据存了密码时，用密码在第三方站点重新登录后再点授权。
 * 两条都走不通才如实返回失败，由界面提供「重新授权」入口。
 */
async function tryRebuildSession(
  site: Site,
  account: Account,
  proxy: string
): Promise<{ ok: boolean; error?: string }> {
  const attempt = await rebuildSession(site, account, {
    proxy,
    findCredential: (id) => store.findCredential(id),
    // 登录接口可能校验 Turnstile：用站点自己的挂件取令牌，不破解、不代答
    acquireTurnstile: async () => {
      const key = site.turnstileSiteKey ?? (await ensureSiteProbed(site.id, proxy))?.turnstileSiteKey
      if (!key) return undefined
      const r = await acquireTurnstileToken(
        site.baseUrl,
        key,
        account.cookie,
        `${site.id}|${account.id}`,
        proxy
      )
      return r.ok ? r.token : undefined
    },
    // GitHub / Linux DO 会话过期：先用分区残留登录态静默重授权；
    // 分区里没有了就用账号记录里的加密备份补回去，再退回凭据密码
    silentReauth: (provider) => {
      const credential = account.credentialId
        ? store.findCredential(account.credentialId)
        : undefined
      return silentReauth(site, account, provider, {
        proxy,
        credential: credential
          ? {
              username: credential.username,
              password: credential.password,
              totpSecret: credential.totpSecret
            }
          : undefined,
        providerCookies: store.findAccount(account.id)?.providerCookies
      })
    }
  })
  if (!attempt.ok) return { ok: false, error: attempt.error }

  // 静默授权会轮换 GitHub 的 user_session，备份必须跟着更新，
  // 否则下次恢复回去的是一份已作废的登录态。
  const providerCookies = await snapshotProviderSession(site, account.id)
  await patchAccount(account.id, {
    cookie: attempt.cookie ?? account.cookie,
    token: attempt.token ?? account.token,
    siteUserId: attempt.siteUserId ?? account.siteUserId,
    ...(providerCookies ? { providerCookies } : {})
  })
  store.log('ok', '会话重建', `${site.name} / ${account.label}：用保存的凭据重新登录成功`, {
    siteId: site.id,
    accountId: account.id
  })
  return { ok: true }
}

/**
 * 刷新失败时保留上一次读到的额度数字。
 *
 * 直接覆盖成 ok:false 会让界面把「可用 / 累计」清成 `—`，看起来像账号
 * 被清空了。失败原因（比如换了节点就通的拦截）和旧数据并不冲突，
 * 正确做法是：保留旧数字，同时标上失败原因与这次尝试的时间。
 *
 * 三种情况区别处理：
 *   - 本次成功：直接采用
 *   - 会话已失效：数字已不可信，不保留
 *   - 其它失败：沿用上一次快照里还活着的金额，哪怕那条快照本身是失败的
 *     （连续失败时不能让数字被一层层抹掉）
 */
function mergeFailedSnapshot(accountId: string, next: QuotaSnapshot): QuotaSnapshot {
  if (next.ok) return next
  if (isSessionExpired(next.error)) return next
  const prev = store.findAccount(accountId)?.lastStatus
  if (!prev) return next
  return {
    ...next,
    available: prev.available ?? next.available,
    used: prev.used ?? next.used,
    todayUsed: prev.todayUsed ?? next.todayUsed,
    checkedToday: prev.checkedToday ?? next.checkedToday
  }
}

/**
 * 修复历史失败快照里丢失的额度数字。
 *
 * 旧版本在刷新失败时把整个快照覆盖成 ok:false，金额随之被抹掉，
 * 界面上就成了「可用 — / 累计 —」。但日志里一直保留着每次成功读取的
 * 「可用 $730.22」，据此可以把数字找回来，避免用户以为数据丢了。
 *
 * 只在「快照失败且没有数字」时补，成功快照一律不动。
 */
async function restoreLostAmounts(): Promise<void> {
  const withSite = store
    .get()
    .sites.flatMap((site) => site.accounts.map((account) => ({ site, account })))
    .filter(({ account }) => account.lastStatus && !account.lastStatus.ok && account.lastStatus.available === undefined)
  if (withSite.length === 0) return

  const logs = store.getLogs()
  let restored = 0
  for (const { account } of withSite) {
    // 从最近的日志里找该账号最后一次成功读到的额度
    const hit = logs.find(
      (l) =>
        l.scope === '额度刷新' &&
        l.accountId === account.id &&
        /可用\s*\$[\d.]+/.test(l.message)
    )
    if (!hit) continue
    const availM = hit.message.match(/可用\s*\$([\d.]+)/)
    if (!availM) continue
    const available = Number(availM[1])
    if (!Number.isFinite(available)) continue
    // 累计金额是后来才写进日志的；老日志里没有就留空，不猜
    const usedM = hit.message.match(/累计\s*\$([\d.]+)/)
    const used = usedM ? Number(usedM[1]) : undefined
    await patchAccount(account.id, {
      lastStatus: {
        ...account.lastStatus!,
        available,
        ...(used !== undefined ? { used } : {})
      }
    })
    restored++
  }
  if (restored > 0) {
    store.log('info', '数据修复', `已从日志恢复 ${restored} 个账号的最近额度`)
  }
}

async function doStatus(
  accountId: string,
  opts: { quiet?: boolean } = {}
): Promise<StatusResultDto> {
  const hit = siteOf(accountId)
  if (!hit) return { ok: false, error: '账号不存在' }
  const proxy = await currentProxy()
  const read = async (): Promise<QuotaSnapshot> => {
    const current = store.findAccount(accountId) ?? hit.account
    return readStatus(hit.site, current, {
      proxy,
      session: sessionDeps(hit.site.id, accountId, proxy)
    })
  }

  let snapshot = await read()
  // 会话过期不再直接把用户推去手动登录：绑了密码凭据就自动重建一次再读
  if (!snapshot.ok && isSessionExpired(snapshot.error)) {
    const rebuilt = await tryRebuildSession(hit.site, hit.account, proxy)
    if (rebuilt.ok) {
      snapshot = await read()
    } else if (rebuilt.error) {
      snapshot = { ...snapshot, error: `${snapshot.error ?? '会话已失效'}；${rebuilt.error}` }
    }
  }
  // 读通了 → 会话可用，清标记；仍是会话失效 → 自动恢复没成功，需要人工登录。
  // 其它失败（风控/网络/限流）不动这个标记：它和会话是否有效无关。
  const reloginPatch =
    snapshot.ok === true
      ? { needsRelogin: false }
      : isSessionExpired(snapshot.error)
        ? { needsRelogin: true }
        : {}
  await patchAccount(accountId, {
    lastStatus: mergeFailedSnapshot(accountId, snapshot),
    ...reloginPatch
  })
  await syncCheckinReceipt(hit.site, accountId, snapshot)
  // quiet：启动时的批量补查不该把每个账号都写成一条「额度刷新」，
  // 那会把运行日志刷满，掩盖真正有信息量的记录
  if (!opts.quiet) {
    store.log(
      snapshot.ok ? 'ok' : 'warn',
      '额度刷新',
      `${hit.site.name} / ${hit.account.label}：${
        snapshot.ok
          ? `可用 $${(snapshot.available ?? 0).toFixed(2)}，累计 $${(snapshot.used ?? 0).toFixed(2)}`
          : snapshot.error
      }`,
      { siteId: hit.site.id, accountId }
    )
  }
  return {
    ok: snapshot.ok,
    available: snapshot.available,
    used: snapshot.used,
    checkedToday: snapshot.checkedToday,
    error: snapshot.error
  }
}

/** 确保站点已缓存 Turnstile sitekey 与协议形态；缺失时现场探测一次。 */
async function ensureSiteProbed(siteId: string, proxy: string): Promise<Site | undefined> {
  const site = store.findSite(siteId)
  if (!site) return undefined
  // 已探测过（有 sitekey 或明确知道站点未开启验证）就直接用；
  // 但配额单位可能是在旧版本里漏采的，缺它会让金额整体换算错，需要补探一次
  if ((site.turnstileSiteKey || site.turnstile === false) && site.quotaPerUnit) return site

  const probe = await probeSite(site.baseUrl, proxy)
  if (!probe.ok) return site
  await store.mutate((config) => {
    const target = config.sites.find((s) => s.id === siteId)
    if (!target) return
    target.turnstile = probe.turnstile
    target.turnstileSiteKey = probe.turnstileSiteKey
    target.backendVersion = probe.systemName
    // 站点声明的配额单位：取错会让所有金额整体差若干倍
    if (probe.quotaPerUnit) target.quotaPerUnit = probe.quotaPerUnit
    // 探测能纠正形态误判（例如自定义站点）
    if (probe.kind) target.kind = probe.kind
  })
  return store.findSite(siteId)
}

async function doCheckin(
  accountId: string,
  opts: { force?: boolean } = {}
): Promise<CheckinResultDto> {
  const hit = siteOf(accountId)
  if (!hit) return { ok: false, already: false, message: '账号不存在' }
  const proxy = await currentProxy()
  const site = (await ensureSiteProbed(hit.site.id, proxy)) ?? hit.site
  const sDeps = sessionDeps(site.id, accountId, proxy)

  // 手动点行内按钮是明确意图：已签也要真的执行一次（重登类站点靠登出再登领取，
  // 拦住它等于按钮失效）。批量签到与定时任务则跳过已签，避免白撞人机验证。
  const plan = planCheckin(site.mode, hit.account.lastCheckin, opts.force === true)
  if (plan.skip) {
    // 写一条日志再返回：批量跑完用户看到「成功 N / 总数」时，
    // 必须能在运行日志里查到每个账号到底是签了还是被跳过，否则没法核对。
    store.log('info', '签到', `${site.name} / ${hit.account.label}：今日已签到，已跳过`, {
      siteId: site.id,
      accountId
    })
    return { ok: true, already: true, message: '今日已签到，已跳过' }
  }

  // RELOGIN 站点：签到 ≡ 登出后重登，且必须以余额增量确认到账。
  // 注意这里刻意不先做会话续期 —— 会话被保活就永远登不出去，也就领不到奖。
  if (site.mode === 'RELOGIN') {
    // 先跟站点核对：今日已有发放记录就不再登出重登（白登一次也领不到第二笔）。
    // 手动触发时不做这一步 —— 用户就是想重登，核对命中会让按钮点不动。
    if (plan.verify) {
      const recon = await reconcileCheckin(site, hit.account, { proxy, session: sDeps })
      if (recon.checked) {
        const receipt: CheckinReceipt = {
          at: Date.now(),
          date: rewardDate(Date.now()),
          ok: true,
          already: true,
          reward: recon.reward,
          rewardSource: 'site',
          rewardCheckedAt: Date.now(),
          message: `今日已签到（${recon.source ?? '站点记录'}）`
        }
        await patchAccount(accountId, { lastCheckin: receipt })
        store.log('ok', '签到', `${site.name} / ${hit.account.label}：${receipt.message}`, {
          siteId: site.id,
          accountId
        })
        return { ok: true, already: true, reward: recon.reward, message: receipt.message }
      }
    }
    const current = store.findAccount(accountId) ?? hit.account
    const credential = current.credentialId ? store.findCredential(current.credentialId) : undefined
    // 分区里还留着第三方登录态时，即使没存密码也能静默点授权登回来；
    // 分区没了但账号记录里有加密备份，同样能恢复 —— 判定必须与重建实现一致，
    // 否则会出现「检查说不放行 → 根本不登出」，每天白错过一次领取。
    const providerAlive =
      (await hasProviderSession(site, current)) ||
      parseProviderCookies(current.providerCookies).length > 0

    const result = await reloginCheckin(site, current, {
      proxy,
      session: sDeps,
      // 登出前先确认登得回来：登不回来就保持现状，绝不把账号弄掉线
      canRelogin: async () => reloginCapability(credential, providerAlive, current.provider),
      readBalance: async (fresh) => {
        if (!fresh) {
          const cached = store.findAccount(accountId)?.lastStatus
          if (cached?.ok && cached.available !== undefined) return cached.available
        }
        const snap = await readStatus(site, store.findAccount(accountId) ?? hit.account, {
          proxy,
          session: sDeps
        })
        await patchAccount(accountId, { lastStatus: snap })
        return snap.ok ? snap.available : undefined
      },
      logout: async () => {
        const r = await logoutSession(site, store.findAccount(accountId) ?? hit.account, {
          proxy,
          session: sDeps,
          log: (level, message, detail) =>
            store.log(level, '登出', message, { siteId: site.id, accountId, detail })
        })
        return r.state === 'confirmed' || r.state === 'absent'
      },
      // 登出后会话已被清掉，恢复必须靠保存的凭据（密码直登或静默 OAuth），
      // 不能指望站点靠残留 Cookie 自己登回来
      rebuild: async () =>
        tryRebuildSession(site, store.findAccount(accountId) ?? hit.account, proxy),
      log: (level, message, detail) =>
        store.log(level, '重登签到', message, { siteId: site.id, accountId, detail })
    })

    if (result.ok) {
      // 到账已由余额增量确认，但增量 ≠ 奖励金额（含同时段消耗与其它入账）。
      // 回执里优先写站点今日发放记录里的真实金额；读不到就留空，绝不写增量。
      const detail = await reconcileCheckin(site, store.findAccount(accountId) ?? hit.account, {
        proxy,
        session: sDeps
      })
      await patchAccount(accountId, {
        // 重登成功即证明会话可用：清掉「需要手动登录」标记
        needsRelogin: false,
        lastCheckin: {
          at: Date.now(),
          date: rewardDate(Date.now()),
          ok: true,
          already: false,
          reward: detail.checked ? detail.reward : undefined,
          rewardSource: 'site',
          // 记下这次核对时间：站点确实读不到金额时，避免下次刷新立刻再问一遍
          rewardCheckedAt: Date.now(),
          message: result.message
        }
      })
    } else if (result.needVisible) {
      // 确实需要人工处理：置 needsRelogin，界面据此显示「重新登录」入口。
      // 保留上一次的额度数字（会话失效不等于余额归零），但要如实标出失败。
      const prev = store.findAccount(accountId)?.lastStatus
      await patchAccount(accountId, {
        needsRelogin: true,
        lastStatus: {
          at: Date.now(),
          ok: false,
          available: prev?.available,
          used: prev?.used,
          error: result.message
        }
      })
    } else {
      // 重登成功但没检测到新的到账：多数是今天已经领过。
      // 这不是失败，去向站点记录确认一次 —— 确认到就按「今日已领」如实返回，
      // 而不是把一次成功的重登报成红色的错误。
      const recon = await reconcileCheckin(site, store.findAccount(accountId) ?? hit.account, {
        proxy,
        session: sDeps
      })
      if (recon.checked) {
        const receipt: CheckinReceipt = {
          at: Date.now(),
          date: rewardDate(Date.now()),
          ok: true,
          already: true,
          reward: recon.reward,
          rewardSource: 'site',
          rewardCheckedAt: Date.now(),
          message: '已重登，今日额度此前已发放'
        }
        await patchAccount(accountId, { lastCheckin: receipt })
        store.log('ok', '签到', `${site.name} / ${hit.account.label}：${receipt.message}`, {
          siteId: site.id,
          accountId
        })
        return { ok: true, already: true, reward: recon.reward, message: receipt.message }
      }
    }
    store.log(result.ok ? 'ok' : 'warn', '签到', `${site.name} / ${hit.account.label}：${result.message}`, {
      siteId: site.id,
      accountId
    })
    return {
      ok: result.ok,
      already: result.already,
      reward: result.reward,
      message: result.message
    }
  }

  const runOpts = { ignoreLocalReceipt: opts.force === true }
  let result = await checkin(
    site,
    hit.account,
    {
      proxy,
      turnstileSiteKey: site.turnstileSiteKey,
      session: sDeps
    },
    runOpts
  )
  // 会话过期时自动重建再签一次，而不是让用户手动重新登录
  if (!result.ok && isSessionExpired(result.message)) {
    const rebuilt = await tryRebuildSession(
      site,
      store.findAccount(accountId) ?? hit.account,
      proxy
    )
    if (rebuilt.ok) {
      result = await checkin(
        site,
        store.findAccount(accountId) ?? hit.account,
        {
          proxy,
          turnstileSiteKey: site.turnstileSiteKey,
          session: sDeps
        },
        runOpts
      )
    }
  }
  if (result.receipt) {
    await patchAccount(accountId, { lastCheckin: result.receipt })
  }
  // 签到成功说明会话可用：清掉可能残留的「需要手动登录」标记
  if (result.ok) {
    await patchAccount(accountId, { needsRelogin: false })
  }
  // 签到失败且是会话类问题时，同步把状态标成失败：
  // 否则账号行仍显示上次成功的旧额度，看起来一切正常，实际早已失效。
  // 自动重建也失败时才需要人工登录，因此重建成功则不置位。
  if (!result.ok && isSessionExpired(result.message)) {
    await patchAccount(accountId, {
      needsRelogin: true,
      lastStatus: {
        at: Date.now(),
        ok: false,
        error: result.message
      }
    })
  }
  store.log(result.ok ? 'ok' : 'warn', '签到', `${site.name} / ${hit.account.label}：${result.message}`, {
    siteId: site.id,
    accountId
  })
  return {
    ok: result.ok,
    already: result.already,
    reward: result.reward,
    message: result.message
  }
}

/** 通知所有窗口重新拉取配置（后台任务改动了账号状态时使用）。 */
function broadcastConfigChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.configChanged)
  }
  updateTrayMenu()
}

/** 依次对全部账号执行一次签到，返回逐项结果（IPC 与托盘菜单共用）。 */
async function runCheckinAll(): Promise<Array<CheckinResultDto & { accountId: string }>> {
  const config = store.getInternal()
  const out: Array<CheckinResultDto & { accountId: string }> = []
  for (const site of config.sites) {
    for (const account of site.accounts) {
      const r = await doCheckin(account.id)
      out.push({ ...r, accountId: account.id })
    }
  }
  return out
}

/** 托盘菜单：随站点/账号数量刷新提示文案，无需重建 Tray。 */
function updateTrayMenu(): void {
  if (!tray) return
  const config = store.get()
  const siteCount = config.sites.length
  const accountCount = config.sites.reduce((n, s) => n + s.accounts.length, 0)
  tray.setToolTip(`AutoSign · ${siteCount} 站点 / ${accountCount} 账号`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 AutoSign', click: () => showMainWindow() },
      {
        label: '立即签到全部',
        enabled: accountCount > 0,
        click: () => {
          void (async () => {
            const results = await runCheckinAll()
            const ok = results.filter((r) => r.ok).length
            if (Notification.isSupported()) {
              new Notification({
                title: '签到完成',
                body: `成功 ${ok} / ${results.length}（详见运行日志）`
              }).show()
            }
          })()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

/**
 * 应用图标路径。
 *
 * 开发模式从 resources 读；打包后 resources 会被复制进 app 目录，
 * 相对 __dirname 的位置一致，因此同一个路径两边都能用。
 */
function appIconPath(): string {
  // Windows 的标题栏 / Alt-Tab / 任务栏会按场景取 16~256 不同档位，
  // 多尺寸 .ico 才能每档都清晰；其余平台用 PNG。
  return join(__dirname, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
}

/**
 * macOS Dock 图标。
 *
 * `BrowserWindow` 的 `icon` 选项只影响窗口本身，不影响 Dock（Dock 图标来自
 * app bundle 的 Info.plist）。开发模式跑的是 Electron 可执行文件，
 * 所以 Dock 上一直是 Electron 的默认图标 —— 必须用 app.dock.setIcon 覆盖。
 */
function applyDockIcon(): void {
  if (process.platform !== 'darwin') return
  try {
    const image = nativeImage.createFromPath(appIconPath())
    if (!image.isEmpty()) app.dock?.setIcon(image)
  } catch {
    // 图标缺失不应阻止启动
  }
}

/**
 * 托盘图标。
 *
 * 三个平台三套做法，都是各自规范里的标准形态：
 *   - macOS 菜单栏只有 22pt 高，用**单色模板图**（纯黑 + alpha），
 *     由系统按亮/暗主题自动反色。同目录还提供 44px 的 @2x 档，
 *     Electron 按文件名自动装载，Retina 下取 @2x 不再放大发虚；
 *     代码里不能 resize 成单档，否则高分屏只剩 1x 表示。
 *   - Windows 通知区在 100%/125%/150%/200% DPI 下分别要
 *     16/20/24/32 物理像素，按 scaleFactor 挂四个表示让系统自选。
 *   - Linux 面板尺寸不一，给 32px 源图由面板自行缩放。
 */
function trayImage(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(join(__dirname, '../../resources/trayTemplate.png'))
    img.setTemplateImage(true)
    return img
  }
  if (process.platform === 'win32') {
    const reps: Array<[number, number]> = [
      [1, 16],
      [1.25, 20],
      [1.5, 24],
      [2, 32]
    ]
    const [firstScale, firstPx] = reps[0]
    const image = nativeImage.createFromBuffer(readFileSync(join(__dirname, `../../resources/tray-${firstPx}.png`)), {
      scaleFactor: firstScale,
      width: 16,
      height: 16
    })
    for (const [scaleFactor, px] of reps.slice(1)) {
      image.addRepresentation({
        scaleFactor,
        width: 16,
        height: 16,
        buffer: readFileSync(join(__dirname, `../../resources/tray-${px}.png`))
      })
    }
    return image
  }
  return nativeImage.createFromPath(join(__dirname, '../../resources/tray-32.png'))
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
  updateTrayMenu()
}

function registerIpc(): void {
  ipcMain.handle(IPC.configGet, () => store.get())

  ipcMain.handle(IPC.settingsUpdate, async (_e, patch: Partial<Settings>) => {
    const next = await store.mutate((config) => {
      config.settings = { ...config.settings, ...patch }
    })
    // 主题变化要同步到原生层（滚动条、菜单等），窗口背景色也随之调整
    if (patch.theme) {
      applyNativeTheme()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(windowBackgroundColor())
      }
    }
    return next
  })

  ipcMain.handle(IPC.siteAdd, async (_e, input: { catalogId?: string; name?: string; baseUrl?: string }) => {
    const proxy = await currentProxy()
    if (input.catalogId) {
      const entry = catalogById(input.catalogId)
      if (!entry) throw new Error('未知的站点目录项')
      const base = siteFromCatalog(entry)
      if (store.findSite(base.id)) return store.get()
      // 内置目录也探测一次：sitekey、配额单位与形态由站点自己决定，不靠硬编码假设
      const probe = await probeSite(base.baseUrl, proxy)
      return store.mutate((config) => {
        if (config.sites.some((s) => s.id === base.id)) return
        config.sites.push({
          ...base,
          kind: probe.ok ? probe.kind : 'NEWAPI',
          mode: probe.ok ? probe.mode : base.mode,
          turnstile: probe.ok ? probe.turnstile : undefined,
          turnstileSiteKey: probe.ok ? probe.turnstileSiteKey : undefined,
          quotaPerUnit: probe.ok ? probe.quotaPerUnit : undefined,
          backendVersion: probe.ok ? probe.systemName : undefined,
          accounts: []
        })
      })
    }
    const name = (input.name ?? '').trim()
    const baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!name || !baseUrl) throw new Error('站点名称与地址不能为空')
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('站点地址必须以 http:// 或 https:// 开头')
    const probe: SiteProbeResult = await probeSite(baseUrl, proxy)
    return store.mutate((config) => {
      config.sites.push({
        id: `custom-${randomUUID().slice(0, 8)}`,
        name,
        baseUrl,
        mode: probe.mode,
        kind: probe.kind,
        provider: 'github',
        custom: true,
        turnstile: probe.turnstile,
        turnstileSiteKey: probe.turnstileSiteKey,
        quotaPerUnit: probe.quotaPerUnit,
        backendVersion: probe.systemName,
        accounts: []
      })
    })
  })

  ipcMain.handle(IPC.siteUpdate, async (_e, siteId: string, patch: Partial<Site>) => {
    return store.mutate((config) => {
      const site = config.sites.find((s) => s.id === siteId)
      // 账号列表不允许从渲染进程整体替换，避免绕过加密与校验
      const { accounts: _ignored, ...safe } = patch
      if (site) Object.assign(site, safe)
    })
  })

  ipcMain.handle(IPC.siteRemove, async (_e, siteId: string) => {
    return store.mutate((config) => {
      config.sites = config.sites.filter((s) => s.id !== siteId)
    })
  })

  ipcMain.handle(IPC.siteReorder, async (_e, siteIds: string[]) => {
    return store.mutate((config) => {
      const map = new Map(config.sites.map((s) => [s.id, s]))
      const ordered = siteIds.map((id) => map.get(id)).filter((s): s is Site => !!s)
      // 未在列表中的站点保持在后，防止渲染进程漏传导致丢站
      for (const site of config.sites) if (!siteIds.includes(site.id)) ordered.push(site)
      config.sites = ordered
    })
  })

  ipcMain.handle(IPC.siteProbe, async (_e, baseUrl: string) => {
    const proxy = await currentProxy()
    return probeSite(baseUrl, proxy)
  })

  // 站点图标：结果与地址一起缓存到磁盘，抓不到返回 undefined 由界面回退字母头像
  ipcMain.handle(IPC.siteIcon, async (_e, baseUrl: string) => {
    const proxy = await currentProxy()
    return getSiteIcon(baseUrl, proxy)
  })

  ipcMain.handle(
    IPC.accountLogin,
    async (
      _e,
      siteId: string,
      provider?: string,
      credentialId?: string,
      reauthAccountId?: string
    ) => {
      const site = store.findSite(siteId)
      if (!site) return { ok: false, error: '站点不存在' } satisfies AccountResultDto
      const proxy = await currentProxy()
      const draftId = randomUUID()

      // 重新授权：沿用原账号身份，只替换会话，不新增记录
      const existing = reauthAccountId
        ? site.accounts.find((a) => a.id === reauthAccountId)
        : undefined
      if (reauthAccountId && !existing) {
        return { ok: false, error: '要重新授权的账号不存在' } satisfies AccountResultDto
      }

      // 取凭据（含密码与 TOTP，仅在主进程内存里出现）
      const credential = credentialId ? store.findCredential(credentialId) : undefined

      // 同一凭据在同一站点只保留一份会话：重复添加只会得到重复账号并占用站点会话名额。
      // 重新授权时排除账号自己，否则会被自己的记录挡住。
      if (
        credentialId &&
        site.accounts.some((a) => a.credentialId === credentialId && a.id !== reauthAccountId)
      ) {
        const who = credential?.displayName || credential?.username || credentialId
        return {
          ok: false,
          error: `${who} 已在该站点登录，无需重复添加`
        } satisfies AccountResultDto
      }

      // 密码登录不需要窗口，也不需要 OAuth：直接打站点 /api/user/login
      if (provider === 'password') {
        if (!credential) {
          return { ok: false, error: '密码登录需要选择一份已保存的凭据' } satisfies AccountResultDto
        }
        const login = await passwordLogin(site, credential, proxy)
        if (!login.ok) {
          store.log('err', '授权', `${site.name}：${login.error}`, { siteId })
          return { ok: false, error: login.error } satisfies AccountResultDto
        }
        const account = accountFromPasswordLogin(site, existing?.id ?? draftId, credential, login)
        await store.mutate((config) => {
          const target = config.sites.find((s) => s.id === siteId)
          if (!target) return
          if (existing) {
            // 重新授权：替换会话与身份锚点，保留原账号的展示顺序与历史回执位置
            const idx = target.accounts.findIndex((a) => a.id === existing.id)
            if (idx >= 0) {
              target.accounts[idx] = {
                ...target.accounts[idx],
                cookie: account.cookie,
                token: account.token,
                siteUserId: account.siteUserId,
                credentialId: account.credentialId,
                provider: account.provider,
                label: account.label
              }
            }
          } else {
            target.accounts.push(account)
          }
          const cred = config.credentials.find((c) => c.id === credential.id)
          if (cred) cred.lastUsedAt = Date.now()
        })
        // 重新授权后 must 用落库后的最新会话去读额度，否则仍拿旧 cookie 必然 401
        const freshAccount = store.findAccount(account.id) ?? account
        const snapshot = await readStatus(site, freshAccount, { proxy })
        if (snapshot.ok) {
          // 重新登录成功：清掉「需要手动登录」标记
          await patchAccount(account.id, { lastStatus: snapshot, needsRelogin: false })
          await syncCheckinReceipt(site, account.id, snapshot)
          store.log('ok', '授权', `${site.name}：已通过密码登录 ${account.label}`, { siteId })
        } else {
          store.log(
            'warn',
            '授权',
            `${site.name}：密码登录成功但额度读取失败（${snapshot.error}）`,
            { siteId }
          )
        }
        return {
          ok: true,
          account: { ...account, lastStatus: snapshot },
          error: snapshot.ok ? undefined : snapshot.error
        } satisfies AccountResultDto
      }

      // 分区必须跟着最终账号 ID 走：重新授权时若用临时 draftId，
      // GitHub 登录态会留在另一套分区里，而账号之后读的是自己那套，
      // 于是每次静默重授权都「找不到登录态」，只能反复手动授权。
      //
      // 打开窗口前先把加密备份里的第三方登录态写回分区：分区可能因为
      // 换机器 / 重装 / 清缓存而空了，补回去之后 GitHub 直接落在授权页，
      // 用户只需确认（或由脚本自动点「Authorize」），不用重输密码。
      await ensureProviderSession(site.id, existing?.id ?? draftId, existing?.providerCookies)
      const result = await runOAuth(site, existing?.id ?? draftId, provider as never, proxy, credential)
      if (!result.ok) {
        store.log('err', '授权', `${site.name}：${result.error}`, { siteId })
        return { ok: false, error: result.error } satisfies AccountResultDto
      }
      const account: Account = {
        id: existing?.id ?? draftId,
        siteId,
        label: result.username ?? existing?.label ?? credential?.username ?? `${site.name} 账号`,
        provider: (provider as Account['provider']) ?? site.provider,
        siteUserId: result.siteUserId,
        credentialId,
        cookie: result.cookie,
        token: result.token,
        createdAt: existing?.createdAt ?? Date.now()
      }
      let error: string | undefined
      await store.mutate((config) => {
        const target = config.sites.find((s) => s.id === siteId)
        if (!target) return
        if (existing) {
          // 重新授权：只换会话，保留原有回执与额度记录
          const idx = target.accounts.findIndex((a) => a.id === existing.id)
          if (idx >= 0) {
            target.accounts[idx] = {
              ...target.accounts[idx],
              cookie: account.cookie,
              token: account.token,
              siteUserId: account.siteUserId,
              credentialId: account.credentialId,
              provider: account.provider,
              label: account.label
            }
          }
        } else {
          target.accounts.push(account)
        }
        // 记录凭据最近使用时间，方便用户区分同名身份
        if (credentialId) {
          const cred = config.credentials.find((c) => c.id === credentialId)
          if (cred) cred.lastUsedAt = Date.now()
        }
      })
      // 取一次额度，验证会话有效并补全 siteUserId
      const freshAccount = store.findAccount(account.id) ?? account
      const snapshot = await readStatus(site, freshAccount, { proxy })
      // 授权成功就把第三方登录态另存一份加密备份：
      // 分区丢失（换机器 / 重装 / 清缓存）时靠它恢复，不必再打扰用户点一次授权。
      // 密码登录没有第三方登录态，采到空值时会跳过写入。
      const providerCookies = await snapshotProviderSession(site, account.id)
      if (snapshot.ok) {
        // 重新授权成功：清掉「需要手动登录」标记
        await patchAccount(account.id, {
          lastStatus: snapshot,
          needsRelogin: false,
          ...(providerCookies ? { providerCookies } : {})
        })
        await syncCheckinReceipt(site, account.id, snapshot)
        store.log('ok', '授权', `${site.name}：已登录 ${account.label}`, { siteId })
      } else {
        error = snapshot.error
        if (providerCookies) await patchAccount(account.id, { providerCookies })
        store.log('warn', '授权', `${site.name}：登录成功但额度读取失败（${snapshot.error}）`, {
          siteId
        })
      }
      return {
        ok: true,
        account: { ...account, lastStatus: snapshot },
        error
      } satisfies AccountResultDto
    }
  )

  ipcMain.handle(IPC.accountRemove, async (_e, accountId: string) => {
    return store.mutate((config) => {
      for (const site of config.sites) {
        site.accounts = site.accounts.filter((a) => a.id !== accountId)
      }
    })
  })

  ipcMain.handle(IPC.accountReorder, async (_e, siteId: string, accountIds: string[]) => {
    return store.mutate((config) => {
      const site = config.sites.find((s) => s.id === siteId)
      if (!site) return
      const map = new Map(site.accounts.map((a) => [a.id, a]))
      const ordered = accountIds.map((id) => map.get(id)).filter((a): a is Account => !!a)
      // 未出现在列表里的账号保持在末尾，避免渲染端漏传导致丢账号
      for (const account of site.accounts) {
        if (!accountIds.includes(account.id)) ordered.push(account)
      }
      site.accounts = ordered
    })
  })

  ipcMain.handle(IPC.accountStatus, (_e, accountId: string) => doStatus(accountId))
  // 行内「签到 / 重登领取」是手动操作：force=true 表示即使今天已签也真的执行一次。
  // 批量与定时任务走 runCheckinAll / scheduleNext，不带 force，已签直接跳过。
  ipcMain.handle(IPC.accountCheckin, (_e, accountId: string, force?: boolean) =>
    doCheckin(accountId, { force: force === true })
  )

  /**
   * 读取账号的 API Key 列表（只读）。
   *
   * Key 属于敏感信息，只在用户主动展开时才请求；日志里只记录数量，
   * 绝不写入 key 原文或脱敏值。
   */
  ipcMain.handle(IPC.accountKeys, async (_e, accountId: string) => {
    const hit = siteOf(accountId)
    if (!hit) return { ok: false, keys: [], error: '账号不存在' }
    const proxy = await currentProxy()
    const result = await readApiKeys(hit.site, hit.account, sessionDeps(hit.site.id, accountId, proxy))
    store.log(
      result.ok ? 'info' : 'warn',
      'Key 列表',
      `${hit.site.name} / ${hit.account.label}：${
        result.ok ? `${result.keys.length} 个 Key` : result.error
      }`,
      { siteId: hit.site.id, accountId }
    )
    return result
  })

  // ---------- 凭据维护 ----------
  // 对外只返回 PublicCredential：密码与 TOTP 原文永不出主进程。

  ipcMain.handle(IPC.credentialList, () => publicCredentials())

  ipcMain.handle(
    IPC.credentialSave,
    async (
      _e,
      input: {
        id?: string
        provider: AuthProvider
        username: string
        displayName?: string
        password?: string
        totpSecret?: string
        note?: string
      }
    ) => {
      const username = (input.username ?? '').trim()
      if (!username) throw new Error('用户名不能为空')
      if (input.provider !== 'github' && input.provider !== 'linuxdo' && input.provider !== 'password') {
        throw new Error('不支持的登录方式')
      }
      if (input.provider === 'password' && !input.password && !input.id) {
        throw new Error('密码登录必须填写密码')
      }
      if (input.totpSecret && !isUsableTotpSecret(input.totpSecret)) {
        throw new Error('TOTP 密钥格式不正确')
      }
      const displayName = input.displayName?.trim() || undefined

      await store.mutate((config) => {
        const index = input.id ? config.credentials.findIndex((c) => c.id === input.id) : -1
        if (index >= 0) {
          const existing = config.credentials[index]
          // 空密码 / 空密钥表示「不修改」，避免编辑其他字段时把已存值清掉
          config.credentials[index] = {
            ...existing,
            provider: input.provider,
            username,
            displayName,
            note: input.note?.trim() || undefined,
            password: input.password ? input.password : existing.password,
            totpSecret: input.totpSecret ? input.totpSecret.replace(/[\s-]/g, '').toUpperCase() : existing.totpSecret
          }
        } else {
          config.credentials.push({
            id: randomUUID(),
            provider: input.provider,
            username,
            displayName,
            note: input.note?.trim() || undefined,
            password: input.password || undefined,
            totpSecret: input.totpSecret
              ? input.totpSecret.replace(/[\s-]/g, '').toUpperCase()
              : undefined,
            createdAt: Date.now()
          })
        }
      })
      store.log(
        'ok',
        '凭据',
        `已保存 ${providerLabelOf(input.provider)} 凭据：${displayName ? `${displayName}（${username}）` : username}`
      )
      return publicCredentials()
    }
  )

  ipcMain.handle(IPC.credentialRemove, async (_e, credentialId: string) => {
    await store.mutate((config) => {
      config.credentials = config.credentials.filter((c) => c.id !== credentialId)
      // 解除账号对该凭据的引用（会话本身仍然有效，只是不再记得来源）
      for (const site of config.sites) {
        for (const account of site.accounts) {
          if (account.credentialId === credentialId) delete account.credentialId
        }
      }
    })
    store.log('info', '凭据', '已移除一条凭据')
    return publicCredentials()
  })

  ipcMain.handle(
    IPC.credentialTest,
    (_e, input: { totpSecret?: string; password?: string }) => {
      // 只做本地格式校验与当前验证码预览，不发起任何网络请求
      if (input.totpSecret) {
        const secret = input.totpSecret.replace(/[\s-]/g, '')
        if (!isUsableTotpSecret(secret)) {
          return { ok: false, error: 'TOTP 密钥格式不正确' }
        }
        try {
          return { ok: true, otp: totp(secret), remaining: secondsRemaining() }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      }
      if (input.password !== undefined) {
        return input.password.length === 0
          ? { ok: false, error: '密码为空' }
          : { ok: true }
      }
      return { ok: false, error: '没有可校验的字段' }
    }
  )

  ipcMain.handle(IPC.checkinAll, () => runCheckinAll())

  ipcMain.handle(IPC.logsGet, (_e, siteId?: string) => store.getLogs(siteId))
  ipcMain.handle(IPC.logsClear, () => store.clearLogs())

  ipcMain.handle(IPC.proxyProbe, (_e, settings: ProxySettings) =>
    probeProxy(settings, 'https://www.gstatic.com/generate_204')
  )

  ipcMain.handle(IPC.turnstileProbe, async (_e, siteId: string) => {
    const proxy = await currentProxy()
    const site = await ensureSiteProbed(siteId, proxy)
    if (!site) return { ok: false, error: '站点不存在' }
    if (!site.turnstileSiteKey) {
      return { ok: false, error: '该站点未开启人机验证或未探测到 sitekey' }
    }
    const account = site.accounts[0]
    const r = await acquireTurnstileToken(
      site.baseUrl,
      site.turnstileSiteKey,
      account?.cookie,
      `${site.id}|${account?.id ?? 'probe'}`,
      proxy
    )
    store.log(
      r.ok ? 'ok' : 'warn',
      '人机验证',
      `${site.name}：${r.ok ? '已取得验证令牌' : r.error}`,
      { siteId: site.id }
    )
    // 只回报长度，绝不把令牌原文写进日志或界面
    return { ok: r.ok, tokenLength: r.token?.length, error: r.error }
  })

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // 只放行 http(s)，避免 file:// 等协议被渲染进程滥用
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })

  ipcMain.handle(IPC.secureInfo, () => ({
    encryptionAvailable: ConfigStore.encryptionAvailable(),
    platform: process.platform
  }))

  // 版本号来源是 package.json：打包后 app.getVersion() 读到的就是它，
  // 开发模式下由构建注入（见 electron.vite.config.ts）
  ipcMain.handle(IPC.appInfo, () => ({
    version: appVersion(),
    updaterAvailable: updaterAvailable(),
    platform: process.platform,
    // 项目与下载地址由主进程给：发布仓库只应有一个来源，界面不要自己拼
    repoUrl: repoHomeUrl(),
    downloadUrl: releasePageUrl()
  }))

  ipcMain.handle(IPC.updateStatus, () => getUpdateStatus())
  ipcMain.handle(IPC.updateCheck, () => checkForUpdates(true))
  ipcMain.handle(IPC.updateInstall, () => {
    quitAndInstall()
  })
  ipcMain.handle(IPC.updateOpenDownload, () => {
    openDownloadPage()
  })
}

/** 后台定时签到：由主进程内的 setTimeout 链驱动，不依赖任何窗口。 */
function scheduleNext(): void {
  const settings: Settings = store.getSettings()
  if (!settings.schedule.enabled) return
  const [hh, mm] = settings.schedule.time.split(':').map((n) => Number(n))
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return

  const now = new Date()
  const next = new Date(now)
  next.setHours(hh, mm, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  if (settings.schedule.weekdaysOnly) {
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1)
  }

  const delay = Math.min(next.getTime() - now.getTime(), 2 ** 31 - 1)
  store.log('info', '调度', `下次自动签到：${next.toLocaleString('zh-CN')}`)
  setTimeout(async () => {
    try {
      store.log('info', '调度', '开始执行定时签到')
      const config = store.getInternal()
      let ok = 0
      let failed = 0
      for (const site of config.sites) {
        for (const account of site.accounts) {
          const r = await doCheckin(account.id)
          if (r.ok) ok++
          else failed++
        }
      }
      // 窗口可能已关闭，此时必须用系统通知把结果送达
      if (Notification.isSupported()) {
        new Notification({
          title: failed === 0 ? '自动签到完成' : '自动签到有未成功项',
          body: `成功 ${ok} 项${failed > 0 ? `，未成功 ${failed} 项（详见运行日志）` : ''}`
        }).show()
      }
    } catch (e) {
      store.log('err', '调度', e instanceof Error ? e.message : String(e))
    } finally {
      scheduleNext()
    }
  }, delay).unref()
}

/** 启动时把旧分区里的 Cookie 搬到统一分区，只做一次。 */
async function migrateLegacyPartitions(): Promise<void> {
  let moved = 0
  for (const site of store.getInternal().sites) {
    for (const account of site.accounts) {
      try {
        moved += await migrateAccountPartition(site, account.id)
      } catch {
        // 单个账号迁移失败不影响启动
      }
    }
  }
  if (moved > 0) {
    store.log('info', '分区迁移', `已把 ${moved} 个历史会话 Cookie 迁入统一分区`)
  }
}

/**
 * 给还没有第三方登录态备份的 OAuth 账号补一份。
 *
 * 备份是「换机器 / 重装后还能静默重授权」的前提，但老版本从不保存它。
 * 只补采分区里确实存在的登录态：分区里没有就跳过，绝不写空值，
 * 这样升级后的用户不必重新授权一次也能用上自动恢复。
 */
async function backfillProviderSessions(): Promise<void> {
  const pending = store
    .getInternal()
    .sites.flatMap((site) =>
      site.accounts
        .filter((a) => a.provider !== 'password' && !a.providerCookies)
        .map((account) => ({ site, account }))
    )
  if (pending.length === 0) return

  let saved = 0
  for (const { site, account } of pending) {
    try {
      const cookies = await snapshotProviderSession(site, account.id)
      if (!cookies) continue
      await patchAccount(account.id, { providerCookies: cookies })
      saved++
    } catch {
      // 单个账号采集失败不影响其余
    }
  }
  if (saved > 0) {
    store.log(
      'info',
      '登录态备份',
      `已为 ${saved} 个账号保存第三方登录态，之后会话过期可自动恢复`
    )
  }
}

/**
 * 启动时给「金额不可信」的今日回执补查一次站点记录。
 *
 * 旧版本把重登前后的余额差写进回执，v0.7.1 起这类金额不再展示，
 * 于是升级后这些账号只剩「已签」没有金额。等用户自己点刷新太被动，
 * 这里在启动后主动补查：查到就把真实奖励写回去，金额立刻恢复显示。
 * 查不到时也会记下时间，6 小时内不再重复请求。
 */
async function backfillCheckinRewards(): Promise<void> {
  const pending = store
    .getInternal()
    .sites.flatMap((site) =>
      site.accounts.filter((a) => needsRewardEnrichment(a.lastCheckin, Date.now()))
    )
  if (pending.length === 0) return
  let filled = 0
  for (const account of pending) {
    try {
      await doStatus(account.id, { quiet: true })
      const after = store.findAccount(account.id)?.lastCheckin
      if (after?.rewardSource === 'site' && after.reward !== undefined) filled++
    } catch {
      // 单个账号失败不影响其余；下次启动或手动刷新会再试
    }
  }
  if (filled > 0) {
    store.log('info', '签到核对', `已从站点记录补全 ${filled} 个账号的签到金额`)
  }
}

/**
 * 给还没有配额单位的站点补探测一次。
 *
 * 旧版本不采集 quota_per_unit，金额一律按 500000 换算。站点若自定义了单位，
 * 界面上所有金额都会整体差若干倍 —— 用户看到的「一堆不对的数据」。
 * 补采一次即可修正，且只在不同步的站点上发请求。
 */
async function backfillQuotaUnits(): Promise<void> {
  const pending = store.get().sites.filter((s) => !s.quotaPerUnit)
  if (pending.length === 0) return
  const proxy = await currentProxy()
  let fixed = 0
  for (const site of pending) {
    try {
      const probe = await probeSite(site.baseUrl, proxy)
      if (!probe.ok || !probe.quotaPerUnit) continue
      await store.mutate((config) => {
        const target = config.sites.find((s) => s.id === site.id)
        if (target && !target.quotaPerUnit) target.quotaPerUnit = probe.quotaPerUnit
      })
      fixed++
    } catch {
      // 单个站点探测失败不影响其余
    }
  }
  if (fixed > 0) {
    store.log('info', '站点探测', `已补齐 ${fixed} 个站点的配额单位，金额换算已校准`)
  }
}

/**
 * 记下窗口当前的几何信息。
 *
 * 最大化 / 全屏时 `getBounds()` 返回的是屏幕大小，直接存下来会让
 * 下次「取消最大化」还原成整屏。所以最大化时只记录标记，尺寸沿用
 * 上一次普通状态的尺寸；还原时 Electron 自己会回到那个尺寸。
 */
function captureWindowBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const maximized = win.isMaximized()
  if (maximized || win.isFullScreen()) {
    const current = windowState.lastNormal
    if (!current) return
    // 全屏不算最大化：下次仍以普通窗口打开，位置与尺寸沿用上一次普通状态
    windowState.schedule({ ...current, maximized })
    return
  }
  const rect = win.getBounds()
  windowState.lastNormal = rect
  windowState.schedule({ ...rect, maximized: false })
}

async function createWindow(): Promise<void> {
  const saved = await windowState.read()
  const primary = screen.getPrimaryDisplay()
  // sanitizeWindowBounds 以数组首项为主屏，getAllDisplays() 的顺序不保证主屏在前
  const displays = [
    { workArea: primary.workArea },
    ...screen
      .getAllDisplays()
      .filter((d) => d.id !== primary.id)
      .map((d) => ({ workArea: d.workArea }))
  ]
  const bounds = sanitizeWindowBounds(saved, displays, {
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 640
  })

  // 移除 Electron 默认菜单（File / Edit / View / Window）。
  // 这个应用的交互都在自绘界面里，原生菜单既用不到、又会在标题栏下方
  // 多出一条与整体风格不一致的条纹。
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    // 隐藏原生标题栏（magpie 风格）：渲染进程自绘标题条承担拖拽与品牌展示，
    // 最小化/最大化/关闭用系统控件 —— Windows 为窗口控制覆叠，macOS 为红绿灯。
    // Linux 不支持隐藏标题栏，保留原生框。
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay() }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
        : {}),
    width: bounds.width,
    height: bounds.height,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: windowBackgroundColor(),
    title: 'AutoSign',
    // 窗口与任务栏图标。打包后由可执行文件自身携带，
    // 这里主要覆盖开发模式（直接跑 electron 时任务栏默认是 Electron 图标）。
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 记住未被最大化时最后一次的普通尺寸，供 captureWindowBounds 使用
  windowState.lastNormal = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }

  // 事件监听要在 maximize() 之前注册，否则恢复最大化状态不会被记录
  // 拖动 / 缩放结束后记录；不监听 resize 过程中的每一帧
  mainWindow.on('resized', () => mainWindow && captureWindowBounds(mainWindow))
  mainWindow.on('moved', () => mainWindow && captureWindowBounds(mainWindow))
  mainWindow.on('maximize', () => mainWindow && captureWindowBounds(mainWindow))
  mainWindow.on('unmaximize', () => mainWindow && captureWindowBounds(mainWindow))
  mainWindow.on('enter-full-screen', () => mainWindow && captureWindowBounds(mainWindow))
  mainWindow.on('leave-full-screen', () => mainWindow && captureWindowBounds(mainWindow))

  if (bounds.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  applyTitleBarOverlay()

  // 关窗最小化到托盘：定时签到依赖主进程存活，直接退出会让「关闭窗口后仍会按时运行」落空
  mainWindow.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    if (mainWindow) captureWindowBounds(mainWindow)
    void windowState.flush()
    mainWindow?.hide()
    if (!trayHintShown) {
      trayHintShown = true
      if (Notification.isSupported()) {
        new Notification({
          title: 'AutoSign 已最小化到托盘',
          body: '定时签到会继续在后台运行；托盘图标右键可恢复窗口或退出。'
        }).show()
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await store.load()
  applyNativeTheme()
  store.setChangeListener(broadcastConfigChanged)
  registerIpc()
  // 把旧分区的登录态搬进统一分区，避免升级后要求重新授权一遍
  await migrateLegacyPartitions()
  // 旧版本失败快照抹掉了额度数字，从日志里补回来
  await restoreLostAmounts()
  // 旧版本没采集配额单位，金额会整体换算错；补探一次即可校准
  void backfillQuotaUnits()
  // 老账号还没有第三方登录态备份，补一份，之后会话过期可自动恢复
  void backfillProviderSessions()
  // 升级后旧回执里的「余额增量」不再展示，启动时主动向站点补查真实金额。
  // 延迟 8 秒再跑：它要对每个账号发请求，跟窗口加载、首轮额度刷新错开，
  // 否则账号多时会明显拖慢启动。
  setTimeout(() => void backfillCheckinRewards(), 8000).unref()
  // macOS 的 Dock 图标不受 BrowserWindow.icon 影响，必须单独设置；
  // 否则开发模式与未正确打包时会显示 Electron 默认图标。
  applyDockIcon()
  await createWindow()
  createTray()
  scheduleNext()
  // 更新状态变化时推给所有窗口（渲染进程只负责展示）
  onUpdateStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.updateChanged, status)
    }
  })
  initUpdater()
  // 主动续期快过期的令牌：避免每次业务请求先吃一个 401 再去续期
  startKeepAlive({
    proxy: () => currentProxy(),
    sites: () => store.getInternal().sites,
    sessionFor: (siteId, accountId, proxy) => sessionDeps(siteId, accountId, proxy),
    log: (message) => store.log('info', '会话保活', message),
    // 上次恢复失败的账号，后台隔一段时间再试一次：多数是瞬时抖动 / 限流 / 风控，
    // 重试一次就通了，用户不必自己想起来去点「重新授权」
    recover: async (accountId) => {
      const hit = siteOf(accountId)
      if (!hit) return { ok: false, error: '账号不存在' }
      const proxy = await currentProxy()
      const snapshot = await readStatus(hit.site, store.findAccount(accountId) ?? hit.account, {
        proxy,
        session: sessionDeps(hit.site.id, accountId, proxy)
      })
      if (!snapshot.ok && isSessionExpired(snapshot.error)) {
        const rebuilt = await tryRebuildSession(
          hit.site,
          store.findAccount(accountId) ?? hit.account,
          proxy
        )
        if (!rebuilt.ok) return { ok: false, error: rebuilt.error }
        const after = await readStatus(hit.site, store.findAccount(accountId) ?? hit.account, {
          proxy,
          session: sessionDeps(hit.site.id, accountId, proxy)
        })
        if (!after.ok) return { ok: false, error: after.error }
        await patchAccount(accountId, { lastStatus: after, needsRelogin: false })
        return { ok: true }
      }
      if (!snapshot.ok) return { ok: false, error: snapshot.error }
      await patchAccount(accountId, { lastStatus: snapshot, needsRelogin: false })
      return { ok: true }
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    else showMainWindow()
  })
})

/**
 * 单实例锁：两个实例同时写同一份配置文件会互相覆盖（丢站点、丢回执），
 * 因此第二个实例直接把已有窗口拉到前台并退出。
 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

// 常驻托盘：窗口全部关闭（隐藏）后应用继续运行，保证定时签到不断
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  quitting = true
  // 退出前把最后一次窗口位置落盘，避免拖动后立刻退出丢失
  if (mainWindow && !mainWindow.isDestroyed()) captureWindowBounds(mainWindow)
  windowState.flushSync()
})
