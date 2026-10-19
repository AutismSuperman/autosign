/**
 * 跨进程共享的数据模型。
 *
 * 存储时 token / cookie / 密码一律经 Electron safeStorage（Windows DPAPI、
 * macOS Keychain、Linux libsecret）加密后落盘，明文只在主进程内存中短暂存在。
 */

/** 签到方式。与上游 Android 端 SiteProfile.CheckinMode 对齐，但只保留桌面端需要的子集。 */
export type CheckinMode = 'BUTTON' | 'RELOGIN' | 'LOGIN_GRANT' | 'WEB_ONLY'

/** 站点协议形态，用于决定端点与字段。 */
export type SiteKind = 'NEWAPI' | 'SUB2API' | 'WELFARE'

/**
 * 登录方式。
 *
 * github / linuxdo 走站点 OAuth；password 走站点的 /api/user/login
 * （New API 系原生支持的邮箱或用户名 + 密码登录）。
 * 后者不需要打开任何窗口，也不需要 Turnstile（除非站点单独开启）。
 */
export type AuthProvider = 'github' | 'linuxdo' | 'password'

/**
 * 登录凭据。
 *
 * 与「账号」分开：账号是某个站点上的一份会话，凭据是能用来登录的身份。
 * 一个 GitHub 凭据可以授权多个站点，因此凭据在这里单独维护、复用。
 * 密码与 TOTP 密钥加密落盘，绝不出主进程。
 */
export interface Credential {
  id: string
  provider: AuthProvider
  /** GitHub 用户名 / 邮箱，或 Linux DO 用户名。 */
  username: string
  /** 显示名称。列表与站点账号标签优先展示它；为空时回退到 username。 */
  displayName?: string
  /** 登录密码（加密落盘）。 */
  password?: string
  /** TOTP 密钥（Base32，加密落盘）。 */
  totpSecret?: string
  /** 备注，便于区分同名的多个身份。 */
  note?: string
  /** 最近一次成功使用时间。 */
  lastUsedAt?: number
  createdAt: number
}

/** 对外展示的凭据视图：永不含密码与 TOTP 原文。 */
export interface PublicCredential {
  id: string
  provider: AuthProvider
  username: string
  /** 显示名称；未填写时界面回退到 username。 */
  displayName?: string
  note?: string
  /** 是否已保存密码。 */
  hasPassword: boolean
  /** 是否已保存 TOTP。 */
  hasTotp: boolean
  lastUsedAt?: number
  createdAt: number
}

/** 站点目录条目：内置站点清单，添加站点时从这里选。 */
export interface CatalogEntry {
  id: string
  name: string
  baseUrl: string
  affUrl: string
  mode: CheckinMode
  note: string
  provider: AuthProvider
  providers: AuthProvider[]
  /** 站点能力标签，用于卡片展示。 */
  tags?: string[]
}

/** 账号。session 字段加密存储。 */
export interface Account {
  id: string
  siteId: string
  label: string
  provider: AuthProvider
  /** 站点数字用户 ID，New API 系请求需要 New-Api-User 头。 */
  siteUserId?: string
  /** 来源凭据；为空表示当时直接浏览器登录，未预填。 */
  credentialId?: string
  /** 会话 Cookie（加密落盘）。 */
  cookie?: string
  /** 系统访问令牌（加密落盘），可选。 */
  token?: string
  createdAt: number
  lastCheckin?: CheckinReceipt
  lastStatus?: QuotaSnapshot
}

export interface CheckinReceipt {
  at: number
  /** 奖励周期日期，北京时区日界（与站点当地 0 点日窗一致）。 */
  date: string
  ok: boolean
  already: boolean
  reward?: number
  message: string
}

/**
 * 站点上的 API Key（New API 的 token）。
 *
 * 字段按站点实际返回原样保留：key 通常是脱敏的（sk-abc****xyz），
 * 只有新建时站点会给完整值，这里不做任何拼接或补全。
 */
export interface ApiKey {
  id: string
  name: string
  /** 站点返回的 key（可能已脱敏），为空表示站点未返回。 */
  key: string
  /** 分组（站点用于计费/限流的策略组），空字符串表示未分组。 */
  group: string
  userId?: number
  /** 是否启用。 */
  status: boolean
  /** 是否不限额度。 */
  unlimitedQuota: boolean
  remainQuota?: number
  usedQuota?: number
  /** 过期时间（Unix 秒）；-1 表示永不过期。 */
  expiredTime?: number
  createdTime?: number
  accessedTime?: number
}

export interface QuotaSnapshot {  at: number
  ok: boolean
  available?: number
  used?: number
  todayUsed?: number
  checkedToday?: boolean
  /** 站点侧核对确认今日已有签到记录（登录即发放型站点的最终判据）。 */
  siteChecked?: boolean
  /** 站点核对解析出的奖励金额（USD）。 */
  siteReward?: number
  /** 站点核对命中来源，写日志与回执用。 */
  checkinSource?: string
  /** 失败原因，成功时为空。 */
  error?: string
}

/** 站点实例。 */
export interface Site {
  id: string
  name: string
  baseUrl: string
  mode: CheckinMode
  kind: SiteKind
  provider: AuthProvider
  affUrl?: string
  /** 站点说明，来自内置目录。 */
  note?: string
  /** 探测得到的 Turnstile sitekey，签到取令牌时需要。 */
  turnstileSiteKey?: string
  /** 探测得知站点是否启用人机验证。 */
  turnstile?: boolean
  /** 探测得到的站点后端版本，便于诊断协议变化。 */
  backendVersion?: string
  /** 用户自定义站点（不在内置目录中）。 */
  custom?: boolean
  /** 侧边栏隐藏（数据保留）。 */
  hidden?: boolean
  accounts: Account[]
}

export type ProxyMode = 'system' | 'direct' | 'manual'

/** 界面主题：暗色 / 亮色 / 跟随系统。 */
export type ThemeMode = 'dark' | 'light' | 'system'

/** 站点列表排序方式：自定义（拖拽顺序）/ 可用额度 / 累计消耗 / 名称。 */
export type SiteSort = 'custom' | 'available' | 'used' | 'name'

/** 排序方向。 */
export type SortDirection = 'asc' | 'desc'

/** 账号列表排序方式：登录顺序 / 可用额度 / 累计消耗 / 名称 / 最近刷新。 */
export type AccountSort = 'custom' | 'available' | 'used' | 'name' | 'refreshed'

export interface ProxySettings {
  mode: ProxyMode
  /** manual 模式下的代理地址，支持 http:// 与 socks5://。 */
  url: string
}

export interface ScheduleSettings {
  enabled: boolean
  /** HH:mm，本地时间。 */
  time: string
  weekdaysOnly: boolean
}

export interface Settings {
  proxy: ProxySettings
  schedule: ScheduleSettings
  /** 侧边栏折叠为图标条。 */
  sidebarCollapsed: boolean
  /** 隐藏站点在侧边栏同时收起（默认 true）。 */
  hideHiddenSites: boolean
  /** 界面主题（默认 dark）。 */
  theme: ThemeMode
  /** 站点列表排序方式（默认 custom，即拖拽顺序）。 */
  siteSort: SiteSort
  /** 站点列表排序方向（金额默认降序，名称默认升序）。 */
  siteSortDir: SortDirection
  /** 账号列表排序方式（默认 custom，即登录顺序）。 */
  accountSort: AccountSort
  /** 账号列表排序方向（金额默认降序，名称默认升序）。 */
  accountSortDir: SortDirection
  /** 账号打码：开启后账号名、登录邮箱等身份信息在界面上以掩码显示。 */
  maskAccounts: boolean
}

export interface AppConfig {
  version: number
  sites: Site[]
  credentials: Credential[]
  settings: Settings
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'err'

export interface LogEntry {
  id: string
  at: number
  level: LogLevel
  scope: string
  siteId?: string
  accountId?: string
  message: string
  detail?: string
}

/** 代理探测结果，供设置页展示。 */
export interface ProxyProbeResult {
  ok: boolean
  /** 实际使用的代理地址，direct 时为空。 */
  proxy?: string
  /** 解析来源：env / registry / scutil / manual / none。 */
  source: string
  error?: string
}

export interface SiteProbeResult {
  ok: boolean
  baseUrl: string
  http: number
  /** 站点声明的名称。 */
  systemName?: string
  kind: SiteKind
  mode: CheckinMode
  turnstile: boolean
  turnstileSiteKey?: string
  checkinEnabled?: boolean
  githubOAuth?: boolean
  linuxdoOAuth?: boolean
  githubClientId?: string
  error?: string
  /** 是否过 WAF 质询，用于诊断。 */
  wafSolved: boolean
}
