import type { ZcodeApi } from '../shared/ipc'

declare global {
  interface Window {
    api: ZcodeApi
  }
}

export {}
