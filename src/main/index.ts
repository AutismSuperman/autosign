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
import { checkin, readStatus, reconcileCheckin } from './sites/engine'
import { runOAuth } from './sites/oauth'
import { acquireTurnstileToken } from './sites/turnstile'
import { reloginCheckin } from './sites/relogin'
import { logoutSession } from './sites/logout'
import { isSessionExpired, rebuildSession, reloginCapability } from './sites/reloginSession'
import { hasProviderSession, silentReauth } from './sites/silentReauth'
import { startKeepAlive } from './sites/keepAlive'
import { migrateAccountPartition } from './sites/partitionMigrate'
import { readApiKeys } from './sites/tokens'
import { getSiteIcon } from './sites/favicon'
import { checkedInThisPeriod, rewardDate } from './sites/profile'
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
  quitAndInstall,
  updaterAvailable
} from './updater'

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
}

/** 窗口初始背景色与主题一致，避免启动瞬间闪色。 */
function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f6fa'
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
  const config = store.get()
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
 * 站点核对命中今日签到记录、但本地没有回执时补记回执。
 * 登录即发放型站点的额度由站点在登录动作里发放（网页登录、站点会话触发都算），
 * 本地重登流程看不到这笔钱；不补记回执徽章就会一直显示「未签」。
 */
async function syncCheckinReceipt(site: Site, accountId: string, snapshot: QuotaSnapshot): Promise<void> {
  if (!snapshot.ok || !snapshot.siteChecked) return
  const account = store.findAccount(accountId)
  if (!account || checkedInThisPeriod(account.lastCheckin, Date.now())) return
  const reward = snapshot.siteReward
  const receipt: CheckinReceipt = {
    at: Date.now(),
    date: rewardDate(Date.now()),
    ok: true,
    already: true,
    reward,
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
    // 分区登录态也失效时，退回用凭据里的密码重新登录第三方站点
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
          : undefined
      })
    }
  })
  if (!attempt.ok) return { ok: false, error: attempt.error }

  await patchAccount(account.id, {
    cookie: attempt.cookie ?? account.cookie,
    token: attempt.token ?? account.token,
    siteUserId: attempt.siteUserId ?? account.siteUserId
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

async function doStatus(accountId: string): Promise<StatusResultDto> {
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
  await patchAccount(accountId, { lastStatus: mergeFailedSnapshot(accountId, snapshot) })
  await syncCheckinReceipt(hit.site, accountId, snapshot)
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
  // 已探测过（有 sitekey 或明确知道站点未开启验证）就直接用
  if (site.turnstileSiteKey || site.turnstile === false) return site

  const probe = await probeSite(site.baseUrl, proxy)
  if (!probe.ok) return site
  await store.mutate((config) => {
    const target = config.sites.find((s) => s.id === siteId)
    if (!target) return
    target.turnstile = probe.turnstile
    target.turnstileSiteKey = probe.turnstileSiteKey
    target.backendVersion = probe.systemName
    // 探测能纠正形态误判（例如自定义站点）
    if (probe.kind) target.kind = probe.kind
  })
  return store.findSite(siteId)
}

async function doCheckin(accountId: string): Promise<CheckinResultDto> {
  const hit = siteOf(accountId)
  if (!hit) return { ok: false, already: false, message: '账号不存在' }
  const proxy = await currentProxy()
  const site = (await ensureSiteProbed(hit.site.id, proxy)) ?? hit.site
  const sDeps = sessionDeps(site.id, accountId, proxy)

  // RELOGIN 站点：签到 ≡ 登出后重登，且必须以余额增量确认到账。
  // 注意这里刻意不先做会话续期 —— 会话被保活就永远登不出去，也就领不到奖。
  if (site.mode === 'RELOGIN') {
    // 先跟站点核对：今日已有发放记录就不再登出重登（白登一次也领不到第二笔）
    const recon = await reconcileCheckin(site, hit.account, { proxy, session: sDeps })
    if (recon.checked) {
      const receipt: CheckinReceipt = {
        at: Date.now(),
        date: rewardDate(Date.now()),
        ok: true,
        already: true,
        reward: recon.reward,
        message: `今日已签到（${recon.source ?? '站点记录'}）`
      }
      await patchAccount(accountId, { lastCheckin: receipt })
      store.log('ok', '签到', `${site.name} / ${hit.account.label}：${receipt.message}`, {
        siteId: site.id,
        accountId
      })
      return { ok: true, already: true, reward: recon.reward, message: receipt.message }
    }
    const current = store.findAccount(accountId) ?? hit.account
    const credential = current.credentialId ? store.findCredential(current.credentialId) : undefined
    // 分区里还留着第三方登录态时，即使没存密码也能静默点授权登回来
    const providerAlive = await hasProviderSession(site, current)

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
      await patchAccount(accountId, {
        lastCheckin: {
          at: Date.now(),
          date: rewardDate(Date.now()),
          ok: true,
          already: false,
          reward: result.reward,
          message: result.message
        }
      })
    } else if (result.needVisible) {
      // 确实需要人工处理：把原因写进 lastStatus，账号行才会出现「重新授权」入口。
      // 保留上一次的额度数字（会话失效不等于余额归零），但要如实标出失败。
      const prev = store.findAccount(accountId)?.lastStatus
      await patchAccount(accountId, {
        lastStatus: {
          at: Date.now(),
          ok: false,
          available: prev?.available,
          used: prev?.used,
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

  let result = await checkin(site, hit.account, {
    proxy,
    turnstileSiteKey: site.turnstileSiteKey,
    session: sDeps
  })
  // 会话过期时自动重建再签一次，而不是让用户手动重新登录
  if (!result.ok && isSessionExpired(result.message)) {
    const rebuilt = await tryRebuildSession(
      site,
      store.findAccount(accountId) ?? hit.account,
      proxy
    )
    if (rebuilt.ok) {
      result = await checkin(site, store.findAccount(accountId) ?? hit.account, {
        proxy,
        turnstileSiteKey: site.turnstileSiteKey,
        session: sDeps
      })
    }
  }
  if (result.receipt) {
    await patchAccount(accountId, { lastCheckin: result.receipt })
  }
  // 签到失败且是会话类问题时，同步把状态标成失败：
  // 否则账号行仍显示上次成功的旧额度，看起来一切正常，实际早已失效。
  if (!result.ok && isSessionExpired(result.message)) {
    await patchAccount(accountId, {
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
  const config = store.get()
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
  return join(__dirname, '../../resources/icon.png')
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

function createTray(): void {
  // 托盘图标复用窗口图标；Windows 下小尺寸更清晰
  const image = nativeImage.createFromPath(appIconPath())
  tray = new Tray(process.platform === 'win32' ? image.resize({ width: 18, height: 18 }) : image)
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
      // 内置目录也探测一次：sitekey 与形态由站点自己决定，不靠硬编码假设
      const probe = await probeSite(base.baseUrl, proxy)
      return store.mutate((config) => {
        if (config.sites.some((s) => s.id === base.id)) return
        config.sites.push({
          ...base,
          kind: probe.ok ? probe.kind : 'NEWAPI',
          mode: probe.ok ? probe.mode : base.mode,
          turnstile: probe.ok ? probe.turnstile : undefined,
          turnstileSiteKey: probe.ok ? probe.turnstileSiteKey : undefined,
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
          await patchAccount(account.id, { lastStatus: snapshot })
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
      if (snapshot.ok) {
        await patchAccount(account.id, { lastStatus: snapshot })
        await syncCheckinReceipt(site, account.id, snapshot)
        store.log('ok', '授权', `${site.name}：已登录 ${account.label}`, { siteId })
      } else {
        error = snapshot.error
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
  ipcMain.handle(IPC.accountCheckin, (_e, accountId: string) => doCheckin(accountId))

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
    platform: process.platform
  }))

  ipcMain.handle(IPC.updateStatus, () => getUpdateStatus())
  ipcMain.handle(IPC.updateCheck, () => checkForUpdates(true))
  ipcMain.handle(IPC.updateInstall, () => {
    quitAndInstall()
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
      const config = store.get()
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
  for (const site of store.get().sites) {
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
    sites: () => store.get().sites,
    sessionFor: (siteId, accountId, proxy) => sessionDeps(siteId, accountId, proxy),
    log: (message) => store.log('info', '会话保活', message)
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
