import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ZcodeApi } from '../shared/ipc'
import type { ProxySettings, Settings, Site } from '../shared/types'

/**
 * 预加载脚本：只暴露一组窄接口，不暴露 ipcRenderer 本身。
 * contextIsolation 保持开启，渲染进程无法直接触碰 Node 或主进程对象。
 */
const api: ZcodeApi = {
  config: {
    get: () => ipcRenderer.invoke(IPC.configGet),
    updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    addSite: (input) => ipcRenderer.invoke(IPC.siteAdd, input),
    updateSite: (siteId: string, patch: Partial<Site>) =>
      ipcRenderer.invoke(IPC.siteUpdate, siteId, patch),
    removeSite: (siteId: string) => ipcRenderer.invoke(IPC.siteRemove, siteId),
    reorderSites: (siteIds: string[]) => ipcRenderer.invoke(IPC.siteReorder, siteIds),
    probeSite: (baseUrl: string) => ipcRenderer.invoke(IPC.siteProbe, baseUrl),
    icon: (baseUrl: string) => ipcRenderer.invoke(IPC.siteIcon, baseUrl)
  },
  account: {
    login: (siteId: string, provider?: string, credentialId?: string, reauthAccountId?: string) =>
      ipcRenderer.invoke(IPC.accountLogin, siteId, provider, credentialId, reauthAccountId),
    remove: (accountId: string) => ipcRenderer.invoke(IPC.accountRemove, accountId),
    reorder: (siteId: string, accountIds: string[]) =>
      ipcRenderer.invoke(IPC.accountReorder, siteId, accountIds),
    status: (accountId: string) => ipcRenderer.invoke(IPC.accountStatus, accountId),
    keys: (accountId: string) => ipcRenderer.invoke(IPC.accountKeys, accountId),
    checkin: (accountId: string, force?: boolean) =>
      ipcRenderer.invoke(IPC.accountCheckin, accountId, force)
  },
  credential: {
    list: () => ipcRenderer.invoke(IPC.credentialList),
    save: (input) => ipcRenderer.invoke(IPC.credentialSave, input),
    remove: (credentialId: string) => ipcRenderer.invoke(IPC.credentialRemove, credentialId),
    test: (input) => ipcRenderer.invoke(IPC.credentialTest, input)
  },
  checkinAll: () => ipcRenderer.invoke(IPC.checkinAll),
  logs: {
    get: (siteId?: string) => ipcRenderer.invoke(IPC.logsGet, siteId),
    clear: () => ipcRenderer.invoke(IPC.logsClear)
  },
  proxy: {
    probe: (settings: ProxySettings) => ipcRenderer.invoke(IPC.proxyProbe, settings),
    turnstile: (siteId: string) => ipcRenderer.invoke(IPC.turnstileProbe, siteId)
  },
  app: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
    secureInfo: () => ipcRenderer.invoke(IPC.secureInfo),
    info: () => ipcRenderer.invoke(IPC.appInfo),
    onConfigChanged: (listener: () => void) => {
      const handler = (): void => listener()
      ipcRenderer.on(IPC.configChanged, handler)
      return () => ipcRenderer.removeListener(IPC.configChanged, handler)
    }
  },
  update: {
    check: () => ipcRenderer.invoke(IPC.updateCheck, true),
    current: () => ipcRenderer.invoke(IPC.updateStatus),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    openDownload: () => ipcRenderer.invoke(IPC.updateOpenDownload),
    onChange: (listener) => {
      const handler = (_e: unknown, status: Parameters<typeof listener>[0]): void => listener(status)
      ipcRenderer.on(IPC.updateChanged, handler)
      return () => ipcRenderer.removeListener(IPC.updateChanged, handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
