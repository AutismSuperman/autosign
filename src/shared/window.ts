export interface WindowChromeState {
  maximized: boolean
  fullScreen: boolean
  title: string
  theme: 'dark' | 'light'
  origin?: string
}

export type WindowCommand = 'minimize' | 'toggleMaximize' | 'close'

export const WINDOW_IPC = {
  state: 'window:state',
  command: 'window:command',
  changed: 'window:changed'
} as const

export interface WindowControlsApi {
  state(): Promise<WindowChromeState>
  command(command: WindowCommand): Promise<void>
  onChange(listener: (state: WindowChromeState) => void): () => void
}

declare global {
  interface Window {
    windowControls: WindowControlsApi
  }
}
