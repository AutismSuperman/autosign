import { app, dialog, Notification, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import type { UpdateStatus } from '../shared/ipc'
import {
  friendlyUpdateError,
  parseDeveloperIdSigned,
  pickMacDownload,
  releasePageUrl,
  requiresManualInstall,
  resolveAssetUrl
} from './updatePolicy'
import { NotifyStateStore } from './notifyState'

/**
 * 应用更新。
 *
 * 发布渠道是 GitHub Release：CI 在打 tag（里程碑）时构建安装包并上传，
 * `electron-updater` 按 Release 里的 latest.yml / latest-mac.yml 判断是否有新版本。
 *
 * 平台差异（这是本模块存在的主要原因）：
 *   - Windows / Linux：下载安装包后由 electron-updater 直接安装；
 *   - macOS：Squirrel.Mac 只接受 **zip** 包，且会用「当前已安装应用」的
 *     designated requirement 校验新包。ad-hoc 签名（没有 Developer ID 证书）
 *     的这条要求绑定当次构建的 cdhash，新版本必然校验失败。
 *     因此非 Developer ID 签名的 macOS 构建不尝试应用内安装，
 *     检查到新版本后直接给出该架构的安装包链接，由用户手动覆盖安装。
 *
 * 设计取舍：
 *   - 默认「自动下载、装到下次退出」：用户不必盯着进度条，
 *     也不会在签到进行中突然重启；
 *   - 用户主动点「检查更新」时，下载完成后询问是否立刻重启安装；
 *   - 后台定时检查只提示「已就绪」，把重启决定权留给用户；
 *   - 开发模式与未打包版本直接跳过——没有 app-update.yml，检查必然失败。
 */

export type { UpdateStatus }

type Listener = (status: UpdateStatus) => void

let current: UpdateStatus = { state: 'idle' }
const listeners = new Set<Listener>()
/** 是否由用户手动触发：决定下载完成后要不要弹「立即重启」。 */
let interactive = false
let initialized = false
/** macOS 是否能用应用内安装（需要 Developer ID 签名）。null 表示尚未检测。 */
let inAppInstallable: boolean | null = null
let signingProbe: Promise<boolean> | null = null
/** 记录哪些版本已经主动提示过，保证同一版本只打扰一次。 */
let notifyState: NotifyStateStore | null = null

function emit(status: UpdateStatus): void {
  current = status
  for (const l of listeners) {
    try {
      l(status)
    } catch {
      // 单个订阅者出错不影响其它窗口
    }
  }
}

/** 开发模式 / 未打包时没有更新配置，直接跳过，避免误报错误。 */
export function updaterAvailable(): boolean {
  return app.isPackaged
}

/**
 * 当前版本号。
 *
 * 打包后与 app.getVersion() 相同；开发模式下后者会回退成 Electron 的版本，
 * 因此优先使用构建时从 package.json 注入的值。
 */
export function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : app.getVersion()
}

export function getUpdateStatus(): UpdateStatus {
  return current
}

export function onUpdateStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 判断当前 macOS 构建能否应用内安装。
 *
 * Windows / Linux 恒为 true；macOS 读取自身代码签名里的 Authority，
 * 只有 Developer ID 签名才能跨版本通过 Squirrel 的 designated requirement 校验。
 * 读不到签名信息时按「不能」处理：宁可给出手动下载入口，
 * 也不要让用户看到一次注定失败的下载。
 */
async function detectInAppInstallable(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  if (inAppInstallable !== null) return inAppInstallable
  if (signingProbe) return signingProbe

  signingProbe = (async () => {
    try {
      const { stderr } = await promisify(execFile)(
        '/usr/bin/codesign',
        ['-dv', '--verbose=4', process.execPath],
        { timeout: 5000 }
      )
      // codesign 把详细信息写到 stderr
      inAppInstallable = !requiresManualInstall(process.platform, parseDeveloperIdSigned(stderr))
    } catch (e) {
      // 非零退出码也带着输出，签名信息可能就在 stderr 里
      const stderr = (e as { stderr?: string }).stderr ?? ''
      inAppInstallable = !requiresManualInstall(process.platform, parseDeveloperIdSigned(stderr))
    }
    return inAppInstallable
  })()
  return signingProbe
}

/**
 * 按签名方式设置下载行为。
 *
 * 应用内安装不可用时必须关掉 autoDownload：否则会先下载一个注定
 * 通不过签名校验的包，用户看到的进度条走完后仍然失败。
 */
async function applyInstallMode(): Promise<boolean> {
  const installable = await detectInAppInstallable()
  autoUpdater.autoDownload = installable
  autoUpdater.autoInstallOnAppQuit = installable
  return installable
}

/** 从更新清单里取出当前架构的安装包地址。 */
function manualUrlFor(info: UpdateInfo): string {
  const files = (info.files ?? []).map((f) => ({ url: f.url }))
  const picked = pickMacDownload(files, process.arch)
  return picked ? resolveAssetUrl(info.version, picked) : releasePageUrl()
}

/**
 * 手动或自动触发一次检查。
 *
 * @param fromUser 用户主动点的（界面会给出可见反馈）
 */
export async function checkForUpdates(fromUser = false): Promise<UpdateStatus> {
  if (!updaterAvailable()) {
    const status: UpdateStatus = {
      state: 'error',
      message: '开发模式不支持自动更新，请使用安装版'
    }
    emit(status)
    return status
  }
  if (current.state === 'checking' || current.state === 'downloading') return current

  interactive = fromUser
  emit({ state: 'checking' })
  try {
    // 签名探测必须先于检查完成：否则 autoDownload 还是 true，
    // 在 macOS 上会先下载一个注定装不上的包。
    await applyInstallMode()
    await autoUpdater.checkForUpdates()
  } catch (e) {
    emit({
      state: 'error',
      message: friendlyUpdateError(e instanceof Error ? e.message : String(e)),
      // macOS 上任何更新失败都应有一个兜底入口，否则用户只能干等
      manualUrl: process.platform === 'darwin' ? releasePageUrl() : undefined
    })
  }
  return current
}

/** 现在就重启并安装已下载的更新。 */
export function quitAndInstall(): void {
  if (current.state !== 'ready') return
  // isSilent=false、isForceRunAfter=true：正常安装并在结束后自动拉起应用
  autoUpdater.quitAndInstall(false, true)
}

/** 打开手动下载页面（macOS 非 Developer ID 构建的更新路径）。 */
export function openDownloadPage(): void {
  const url =
    current.state === 'manual'
      ? current.url
      : current.state === 'error' && current.manualUrl
        ? current.manualUrl
        : releasePageUrl()
  void shell.openExternal(url)
}

/**
 * 后台检查发现新版本时主动提示一次。
 *
 * 用系统通知而不是模态框：这个应用多数时间在托盘里，
 * 模态框会抢焦点打断正在做的事，而通知点一下就能去下载。
 * 同一版本只提示一次，之后再检查到只在设置页更新状态。
 */
async function notifyOnce(version: string): Promise<void> {
  if (notifyState) {
    await notifyState.load()
    if (!notifyState.shouldNotify(version)) return
    // 先落盘再弹：宁可少提示一次，也不要在通知中心堆一串重复条目
    await notifyState.markNotified(version)
  }
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: 'AutoSign 有新版本',
    body: `v${version} 已发布。点击下载安装包，覆盖安装后账号与配置都会保留。`
  })
  n.on('click', () => {
    // 后台检查时不抢焦点，用户点通知才把窗口带到前台
    openDownloadPage()
  })
  n.show()
}

/**
 * 初始化事件监听。只在主进程启动时调用一次。
 *
 * 自动检查放在启动后一段时间，避免和窗口加载、首轮额度刷新抢带宽。
 */
export function initUpdater(): void {
  if (initialized || !updaterAvailable()) return
  initialized = true

  notifyState = new NotifyStateStore(`${app.getPath('userData')}/update-notify.json`)
  void notifyState.load()

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    void (async () => {
      const installable = await detectInAppInstallable()
      if (!installable) {
        const url = manualUrlFor(info)
        emit({ state: 'manual', version: info.version, url })
        if (interactive) {
          interactive = false
          const r = await dialog.showMessageBox({
            type: 'info',
            title: '发现新版本',
            message: `v${info.version} 已发布。`,
            detail:
              '当前安装的版本不是用 Apple 开发者证书签名的，系统不允许应用内直接安装更新。' +
              '请下载安装包后覆盖安装，账号与配置会保留。',
            buttons: ['下载安装包', '稍后'],
            defaultId: 0,
            cancelId: 1
          })
          if (r.response === 0) openDownloadPage()
        } else {
          await notifyOnce(info.version)
        }
        return
      }
      emit({ state: 'available', version: info.version })
    })()
  })

  autoUpdater.on('update-not-available', () => {
    emit({ state: 'none' })
    if (interactive) {
      void dialog.showMessageBox({
        type: 'info',
        title: '已是最新版本',
        message: `当前版本 v${appVersion()} 已是最新。`,
        buttons: ['好']
      })
    }
    interactive = false
  })

  autoUpdater.on('download-progress', (p) => {
    emit({
      state: 'downloading',
      percent: Math.max(0, Math.min(100, p.percent)),
      transferred: p.transferred,
      total: p.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'ready', version: info.version })
    if (Notification.isSupported()) {
      new Notification({
        title: '更新已下载',
        body: `v${info.version} 已就绪，退出应用后会自动安装。`
      }).show()
    }
    if (interactive) {
      interactive = false
      void dialog
        .showMessageBox({
          type: 'info',
          title: '更新已就绪',
          message: `v${info.version} 已下载完成。`,
          detail: '可以现在重启安装，也可以稍后退出应用时自动安装。',
          buttons: ['立即重启', '稍后'],
          defaultId: 0,
          cancelId: 1
        })
        .then((r) => {
          if (r.response === 0) quitAndInstall()
        })
    }
  })

  autoUpdater.on('error', (err) => {
    const message = friendlyUpdateError(err?.message ?? String(err))
    emit({
      state: 'error',
      message,
      manualUrl: process.platform === 'darwin' ? releasePageUrl() : undefined
    })
    if (interactive) {
      interactive = false
      const manual = process.platform === 'darwin'
      void dialog.showMessageBox({
        type: 'error',
        title: '检查更新失败',
        message,
        detail: manual
          ? '可以稍后重试，或直接下载安装包覆盖安装。'
          : '可以稍后重试；若持续失败，请到项目 Release 页手动下载。',
        buttons: manual ? ['下载安装包', '好'] : ['好'],
        defaultId: manual ? 0 : 0,
        cancelId: manual ? 1 : 0
      }).then((r) => {
        if (manual && r.response === 0) openDownloadPage()
      })
    }
  })

  // 启动后 30 秒检查一次，之后每 6 小时一次
  setTimeout(() => void checkForUpdates(false), 30_000)
  setInterval(() => void checkForUpdates(false), 6 * 3_600_000)
}
