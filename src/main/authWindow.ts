import { app, BrowserWindow, nativeTheme, WebContentsView } from 'electron'
import type { Session, WebContents } from 'electron'
import { join } from 'node:path'
import { attachWindowChrome } from './windowChrome'
import { AUTH_INTERACTIVE_IPC } from '../shared/authWindow'

const TITLE_HEIGHT = 44

/** Remote authorization content never receives the local shell's preload bridge. */
export function createAuthWindow(
  ses: Session, title: string, silent: boolean
): { win: BrowserWindow; web: WebContents } {
  const remotePreferences = {
    session: ses, contextIsolation: true, nodeIntegration: false,
    sandbox: true, backgroundThrottling: false,
    // A hidden browser can still open Windows Security outside its own window.
    disableBlinkFeatures: silent ? 'WebAuth' : undefined,
    preload: silent ? undefined : join(app.getAppPath(), 'out/preload/auth.js')
  }
  if (silent) {
    const win = new BrowserWindow({
      width: 1000, height: 780, show: false, skipTaskbar: true,
      autoHideMenuBar: true, webPreferences: remotePreferences
    })
    return { win, web: win.webContents }
  }
  const win = new BrowserWindow({
    width: 1000, height: 780, minWidth: 640, minHeight: 480,
    frame: false, show: false, title, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1e' : '#f4f4f6',
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: {
      preload: join(app.getAppPath(), 'out/preload/chrome.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  const setOrigin = attachWindowChrome(win, title)
  const content = new WebContentsView({ webPreferences: remotePreferences })
  win.contentView.addChildView(content)
  let interactive = false
  const updateInteractive = (value: boolean): void => {
    interactive = value
    if (!content.webContents.isDestroyed()) {
      content.webContents.send(AUTH_INTERACTIVE_IPC, interactive)
    }
  }
  content.webContents.on('dom-ready', () => updateInteractive(interactive))
  win.on('show', () => updateInteractive(true))
  win.on('hide', () => updateInteractive(false))
  win.on('minimize', () => updateInteractive(false))
  win.on('restore', () => updateInteractive(true))
  const layout = (): void => {
    const [width, height] = win.getContentSize()
    content.setBounds({ x: 0, y: TITLE_HEIGHT, width, height: Math.max(0, height - TITLE_HEIGHT) })
  }
  layout()
  win.on('resize', layout)
  content.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  content.webContents.on('did-navigate', (_event, url) => {
    try { setOrigin(new URL(url).origin) } catch { setOrigin('') }
  })
  win.once('closed', () => {
    if (!content.webContents.isDestroyed()) content.webContents.close()
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const loaded = devUrl
    ? win.loadURL(`${devUrl.replace(/\/$/, '')}/?window=auth`)
    : win.loadFile(join(app.getAppPath(), 'out/renderer/index.html'), { query: { window: 'auth' } })
  void loaded.catch(() => { if (!win.isDestroyed()) win.destroy() })
  return { win, web: content.webContents }
}
