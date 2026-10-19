import { app, dialog, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * 应用更新。
 *
 * 发布渠道是 GitHub Release：CI 在打 tag（里程碑）时构建安装包并上传，
 * `electron-updater` 按 Release 里的 latest.yml 判断是否有新版本。
 *
 * 设计取舍：
 *   - 默认「自动下载、装到下次退出」：用户不必盯着一个进度条，
 *     也不会在签到进行中突然重启；
 *   - 用户主动点「检查更新」时，下载完成后询问是否立刻重启安装；
 *   - 后台定时检查只提示「已就绪」，把重启决定权留给用户；
 *   - 开发模式与未打包版本直接跳过——没有 app-update.yml，检查必然失败。
 */

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'none' }
  | { state: 'downloading'; percent: number; transferred: number; total: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

type Listener = (status: UpdateStatus) => void

let current: UpdateStatus = { state: 'idle' }
const listeners = new Set<Listener>()
/** 是否由用户手动触发：决定下载完成后要不要弹「立即重启」。 */
let interactive = false
let initialized = false

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
    await autoUpdater.checkForUpdates()
  } catch (e) {
    emit({ state: 'error', message: e instanceof Error ? e.message : String(e) })
  }
  return current
}

/** 现在就重启并安装已下载的更新。 */
export function quitAndInstall(): void {
  if (current.state !== 'ready') return
  // isSilent=false、isForceRunAfter=true：正常安装并在结束后自动拉起应用
  autoUpdater.quitAndInstall(false, true)
}

/**
 * 初始化事件监听。只在主进程启动时调用一次。
 *
 * 自动检查放在启动后一段时间，避免和窗口加载、首轮额度刷新抢带宽。
 */
export function initUpdater(): void {
  if (initialized || !updaterAvailable()) return
  initialized = true

  // 允许在没有代码签名的情况下更新（Windows 未签名 NSIS 包仍可用）
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    emit({ state: 'available', version: info.version })
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
    emit({ state: 'error', message: err?.message ?? String(err) })
    if (interactive) {
      interactive = false
      void dialog.showMessageBox({
        type: 'error',
        title: '检查更新失败',
        message: err?.message ?? '未知错误',
        detail: '可以稍后重试；若持续失败，请到项目 Release 页手动下载。',
        buttons: ['好']
      })
    }
  })

  // 启动后 30 秒检查一次，之后每 6 小时一次
  setTimeout(() => void checkForUpdates(false), 30_000)
  setInterval(() => void checkForUpdates(false), 6 * 3_600_000)
}
