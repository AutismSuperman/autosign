import { ipcMain, nativeTheme } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { WINDOW_IPC } from '../shared/window'
import type { WindowChromeState, WindowCommand } from '../shared/window'

const windows = new Map<number, { win: BrowserWindow; title: string; origin?: string }>()
let registered = false

function owner(event: IpcMainInvokeEvent) {
  const record = windows.get(event.sender.id)
  if (!record || record.win.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Window controls are unavailable')
  }
  return record
}

function snapshot(record: { win: BrowserWindow; title: string; origin?: string }): WindowChromeState {
  return {
    maximized: record.win.isMaximized(),
    fullScreen: record.win.isFullScreen(),
    title: record.title,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    origin: record.origin
  }
}

/** Only registered local window shells can control their own window. */
export function attachWindowChrome(win: BrowserWindow, title: string): (origin: string) => void {
  if (!registered) {
    registered = true
    ipcMain.handle(WINDOW_IPC.state, (event) => snapshot(owner(event)))
    ipcMain.handle(WINDOW_IPC.command, (event, command: WindowCommand) => {
      const { win: target } = owner(event)
      if (command === 'minimize') target.minimize()
      else if (command === 'toggleMaximize') {
        if (target.isFullScreen()) target.setFullScreen(false)
        else if (target.isMaximized()) target.unmaximize()
        else target.maximize()
      } else if (command === 'close') target.close()
      else throw new Error('Unknown window command')
    })
  }
  const id = win.webContents.id
  const record = { win, title, origin: undefined as string | undefined }
  windows.set(id, record)
  const publish = (): void => {
    if (!win.isDestroyed()) win.webContents.send(WINDOW_IPC.changed, snapshot(record))
  }
  win.on('maximize', publish)
  win.on('unmaximize', publish)
  win.on('enter-full-screen', publish)
  win.on('leave-full-screen', publish)
  nativeTheme.on('updated', publish)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.once('closed', () => {
    windows.delete(id)
    nativeTheme.removeListener('updated', publish)
  })
  return (origin) => { record.origin = origin; publish() }
}
