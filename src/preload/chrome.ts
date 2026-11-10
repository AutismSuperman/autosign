import { contextBridge, ipcRenderer } from 'electron'
import { WINDOW_IPC } from '../shared/window'
import type { WindowControlsApi } from '../shared/window'

const controls: WindowControlsApi = {
  state: () => ipcRenderer.invoke(WINDOW_IPC.state),
  command: (command) => ipcRenderer.invoke(WINDOW_IPC.command, command),
  onChange: (listener) => {
    const handler = (_event: unknown, state: Parameters<typeof listener>[0]): void => listener(state)
    ipcRenderer.on(WINDOW_IPC.changed, handler)
    return () => ipcRenderer.removeListener(WINDOW_IPC.changed, handler)
  }
}
contextBridge.exposeInMainWorld('windowControls', controls)
