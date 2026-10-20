import type {
  Account,
  ApiKey,
  AppConfig,
  AuthProvider,
  LogEntry,
  ProxyProbeResult,
  ProxySettings,
  PublicCredential,
  Settings,
  Site,
  SiteProbeResult
} from './types'

/**
 * 主进程 ↔ 渲染进程的 IPC 契约。
 *
 * 渲染进程永远不直接发网络请求、不接触明文凭据：
 * 所有站点访问都在主进程完成，凭据只在主进程内存与加密文件之间流动。
 */

export interface CheckinResultDto {
  ok: boolean
  already: boolean
  reward?: number
  message: string
}

export interface StatusResultDto {
  ok: boolean
  available?: number
  used?: number
  checkedToday?: boolean
  error?: string
}

export interface ApiKeyListDto {
  ok: boolean
  keys: ApiKey[]
  error?: string
  /** 解析不到条目时的响应结构摘要，仅用于诊断。 */
  debugShape?: string
}

export interface AccountResultDto {
  ok: boolean
  error?: string
  account?: Account
}

export interface TurnstileProbeResult {
  ok: boolean
  /** 仅返回是否拿到令牌与长度，绝不回传令牌原文。 */
  tokenLength?: number
  error?: string
}

/** 自动更新状态。渲染进程只读，不参与决策。 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'none' }
  | { state: 'downloading'; percent: number; transferred: number; total: number }
  | { state: 'ready'; version: string }
  /**
   * 有新版本但无法应用内安装（当前是 macOS 的非 Developer ID 构建）。
   * 给出该架构的安装包直链，由用户手动下载覆盖安装。
   */
  | { state: 'manual'; version: string; url: string }
  | { state: 'error'; message: string; manualUrl?: string }

export interface AppInfo {
  version: string
  /** 开发模式或未打包时为 false，设置页据此提示更新不可用。 */
  updaterAvailable: boolean
  platform: string
}

export const IPC = {
  configGet: 'config:get',  settingsUpdate: 'settings:update',
  siteAdd: 'site:add',
  siteUpdate: 'site:update',
  siteRemove: 'site:remove',
  siteProbe: 'site:probe',
  siteIcon: 'site:icon',
  siteReorder: 'site:reorder',
  accountLogin: 'account:login',
  accountRemove: 'account:remove',
  accountReorder: 'account:reorder',
  accountStatus: 'account:status',
  accountCheckin: 'account:checkin',
  accountKeys: 'account:keys',
  credentialList: 'credential:list',
  credentialSave: 'credential:save',
  credentialRemove: 'credential:remove',
  credentialTest: 'credential:test',
  checkinAll: 'checkin:all',
  logsGet: 'logs:get',
  logsClear: 'logs:clear',
  proxyProbe: 'proxy:probe',
  turnstileProbe: 'turnstile:probe',
  openExternal: 'app:openExternal',
  secureInfo: 'app:secureInfo',
  appInfo: 'app:info',
  updateCheck: 'update:check',
  updateStatus: 'update:status',
  updateInstall: 'update:install',
  updateOpenDownload: 'update:openDownload',
  /** 主进程 → 渲染进程：配置发生变化，渲染端应重新拉取。 */
  configChanged: 'config:changed',
  /** 主进程 → 渲染进程：自动更新状态变化。 */
  updateChanged: 'update:changed'
} as const

export interface ZcodeApi {
  config: {
    get(): Promise<AppConfig>
    updateSettings(patch: Partial<Settings>): Promise<AppConfig>
    addSite(input: { catalogId?: string; name?: string; baseUrl?: string }): Promise<AppConfig>
    updateSite(siteId: string, patch: Partial<Site>): Promise<AppConfig>
    removeSite(siteId: string): Promise<AppConfig>
    reorderSites(siteIds: string[]): Promise<AppConfig>
    probeSite(baseUrl: string): Promise<SiteProbeResult>
    /** 获取站点图标（data URL）；抓不到时为空。 */
    icon(baseUrl: string): Promise<string | undefined>
  }
  account: {
    /**
     * 登录并新增一个账号。
     *
     * 传 reauthAccountId 时改为「重新授权已有账号」：不新建，而是把该账号的
     * 会话换成刚授权到的这一份，用于 OAuth 会话过期后的恢复。
     */
    login(
      siteId: string,
      provider?: string,
      credentialId?: string,
      reauthAccountId?: string
    ): Promise<AccountResultDto>
    remove(accountId: string): Promise<AppConfig>
    /** 站点内账号排序：按给定 id 顺序重排该站点的账号。 */
    reorder(siteId: string, accountIds: string[]): Promise<AppConfig>
    status(accountId: string): Promise<StatusResultDto>
    checkin(accountId: string): Promise<CheckinResultDto>
    /** 读取该账号在站点上的 API Key 列表（只读）。 */
    keys(accountId: string): Promise<ApiKeyListDto>
  }
  credential: {
    list(): Promise<PublicCredential[]>
    save(input: {
      id?: string
      provider: AuthProvider
      username: string
      displayName?: string
      password?: string
      totpSecret?: string
      note?: string
    }): Promise<PublicCredential[]>
    remove(credentialId: string): Promise<PublicCredential[]>
    /** 校验 TOTP 密钥并返回当前验证码（不落盘）。 */
    test(input: { totpSecret?: string; password?: string }): Promise<{
      ok: boolean
      otp?: string
      remaining?: number
      error?: string
    }>
  }
  checkinAll(): Promise<Array<CheckinResultDto & { accountId: string }>>
  logs: {
    get(siteId?: string): Promise<LogEntry[]>
    clear(): Promise<void>
  }
  proxy: {
    probe(settings: ProxySettings): Promise<ProxyProbeResult>
    /** 诊断用：验证隐藏窗口能否为指定站点取到人机验证令牌。 */
    turnstile(siteId: string): Promise<TurnstileProbeResult>
  }
  app: {
    openExternal(url: string): Promise<void>
    secureInfo(): Promise<{ encryptionAvailable: boolean; platform: string }>
    /** 版本号与更新可用性。版本号唯一来源是 package.json，由主进程读取。 */
    info(): Promise<AppInfo>
    /** 订阅配置变更（后台任务改动了账号状态时，界面需要跟上）。返回取消订阅函数。 */
    onConfigChanged(listener: () => void): () => void
  }
  update: {
    /** 手动检查更新；下载完成后会询问是否立即重启。 */
    check(): Promise<UpdateStatus>
    current(): Promise<UpdateStatus>
    /** 重启并安装已下载的更新。 */
    install(): Promise<void>
    /** 打开手动下载页：macOS 非开发者证书签名的构建无法应用内安装。 */
    openDownload(): Promise<void>
    /** 订阅更新状态变化。返回取消订阅函数。 */
    onChange(listener: (status: UpdateStatus) => void): () => void
  }
}

declare global {
  interface Window {
    api: ZcodeApi
  }
}
