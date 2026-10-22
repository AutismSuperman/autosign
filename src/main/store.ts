import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { open, seal, encryptionAvailable } from './security'
import type {
  Account,
  AppConfig,
  CheckinReceipt,
  Credential,
  LogEntry,
  LogLevel,
  Settings,
  Site
} from '../shared/types'

/**
 * 配置与日志持久化。
 *
 * 写入全部走「读-改-写 + 单写队列」：主进程内所有 IPC 与定时任务共享同一实例，
 * 因此用一个 Promise 串行队列即可避免并发覆盖（上游踩过丢账号的坑）。
 *
 * 敏感字段（cookie / token）落盘前经 security.seal 加密，读出时解密到内存。
 */

const CONFIG_VERSION = 1
const MAX_LOGS = 2000

/** New API 默认配额单位：500000 quota = $1（与 engine 保持一致）。 */
const QUOTA_PER_UNIT = 500_000

/**
 * 修正历史回执里被当成美元展示的 quota 原始值。
 *
 * 旧版本把 `quota_awarded`（如 10000000）直接写进回执，界面上就成了 1000 万。
 * 真正的签到奖励不会有四位数的美元金额，因此把 >= 1000 的值按配额单位折回美元。
 * 只影响旧数据，新回执在写入时就已换算。
 *
 * 同时给旧回执补上 `rewardSource`：重登类站点的历史回执记的是**余额增量**
 * （含同时段消耗与其它入账），不是奖励金额。不标出来，界面就会继续把
 * $20.90、$21.71 这类增量当成「签到 +$xx」展示，也就是用户看到的那堆错数字。
 */
function normalizeReceipt(
  receipt: CheckinReceipt | undefined,
  mode?: Site['mode']
): CheckinReceipt | undefined {
  if (!receipt) return receipt
  const withSource: CheckinReceipt = receipt.rewardSource
    ? receipt
    : { ...receipt, rewardSource: mode === 'RELOGIN' && !receipt.already ? 'delta' : 'site' }
  if (withSource.reward === undefined) return withSource
  if (withSource.reward < 1000) return withSource
  return {
    ...withSource,
    reward: Math.round((withSource.reward / QUOTA_PER_UNIT) * 100) / 100
  }
}

function defaultSettings(): Settings {
  return {
    proxy: { mode: 'system', url: '' },
    schedule: { enabled: false, time: '08:05', weekdaysOnly: false },
    sidebarCollapsed: false,
    hideHiddenSites: true,
    theme: 'dark',
    siteSort: 'custom',
    siteSortDir: 'desc',
    accountSort: 'custom',
    accountSortDir: 'desc',
    maskAccounts: false
  }
}

function defaultConfig(): AppConfig {
  return { version: CONFIG_VERSION, sites: [], credentials: [], settings: defaultSettings() }
}

/** 落盘形态：敏感字段为密文。 */
interface StoredAccount extends Omit<Account, 'cookie' | 'token' | 'providerCookies'> {
  cookie?: string
  token?: string
  providerCookies?: string
}

interface StoredCredential extends Omit<Credential, 'password' | 'totpSecret'> {
  password?: string
  totpSecret?: string
}

interface StoredSite extends Omit<Site, 'accounts'> {
  accounts: StoredAccount[]
}

interface StoredConfig extends Omit<AppConfig, 'sites' | 'credentials'> {
  sites: StoredSite[]
  credentials: StoredCredential[]
}

/**
 * 抹掉会话凭据后的账号：可以安全地经 IPC 交给渲染进程。
 *
 * 存储里 cookie / token / providerCookies 都是明文（解密后），而 `get()` 的结果
 * 会被整包发到渲染进程。界面只用得到额度、回执、标记这些字段，
 * 会话凭据和第三方登录态备份一律不下发 —— 渲染进程拿到就等于凭据越界，
 * 与「凭据只在主进程内存中短暂存在」的约定冲突。
 */
export type PublicAccount = Omit<Account, 'cookie' | 'token' | 'providerCookies'>

export type PublicConfig = Omit<AppConfig, 'sites'> & {
  sites: Array<Omit<Site, 'accounts'> & { accounts: PublicAccount[] }>
}

/** 把配置裁成可以跨进程传输的形态。 */
export function toPublicConfig(config: AppConfig): PublicConfig {
  return {
    ...config,
    sites: config.sites.map((site) => ({
      ...site,
      accounts: site.accounts.map(({ cookie: _c, token: _t, providerCookies: _p, ...rest }) => rest)
    }))
  }
}

export class ConfigStore {
  private config: AppConfig = defaultConfig()
  private logs: LogEntry[] = []
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()
  /** 配置落盘后的回调，用于通知窗口刷新（由主进程注册，避免 store 依赖 electron 窗口）。 */
  private onChange: (() => void) | null = null

  /** 注册变更监听。所有写入路径都会触发，无需在每处手动广播。 */
  setChangeListener(listener: () => void): void {
    this.onChange = listener
  }

  private get configFile(): string {
    return `${app.getPath('userData')}/config.json`
  }

  private get logFile(): string {
    return `${app.getPath('userData')}/logs.json`
  }

  async load(): Promise<void> {
    if (this.loaded) return
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile(this.configFile, 'utf8').catch(() => '')
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StoredConfig
        this.config = this.fromStored(parsed)
      } catch {
        this.config = defaultConfig()
      }
    }
    const rawLogs = await fs.readFile(this.logFile, 'utf8').catch(() => '')
    if (rawLogs) {
      try {
        const parsed = JSON.parse(rawLogs) as LogEntry[]
        if (Array.isArray(parsed)) this.logs = parsed.slice(-MAX_LOGS)
      } catch {
        this.logs = []
      }
    }
    this.loaded = true
  }

  private fromStored(stored: StoredConfig): AppConfig {
    const sites: Site[] = (stored.sites ?? []).map((s) => ({
      ...s,
      accounts: (s.accounts ?? []).map((a) => ({
        ...a,
        cookie: open(a.cookie),
        token: open(a.token),
        providerCookies: open(a.providerCookies),
        lastCheckin: normalizeReceipt(a.lastCheckin, s.mode)
      }))
    }))
    const credentials: Credential[] = (stored.credentials ?? []).map((c) => ({
      ...c,
      password: open(c.password),
      totpSecret: open(c.totpSecret)
    }))
    return {
      version: stored.version ?? CONFIG_VERSION,
      sites,
      credentials,
      settings: { ...defaultSettings(), ...(stored.settings ?? {}) }
    }
  }

  /** 序列化为落盘形态。加密失败时抛出，避免明文写盘。 */
  private toStored(config: AppConfig): StoredConfig {
    const sites: StoredSite[] = config.sites.map((s) => ({
      ...s,
      accounts: s.accounts.map((a) => {
        const out: StoredAccount = { ...a }
        if (a.cookie) {
          const sealed = seal(a.cookie)
          if (sealed === null) throw new Error('系统加密不可用，已拒绝写入会话凭据')
          out.cookie = sealed
        } else {
          delete out.cookie
        }
        if (a.token) {
          const sealed = seal(a.token)
          if (sealed === null) throw new Error('系统加密不可用，已拒绝写入访问令牌')
          out.token = sealed
        } else {
          delete out.token
        }
        if (a.providerCookies) {
          const sealed = seal(a.providerCookies)
          if (sealed === null) throw new Error('系统加密不可用，已拒绝写入第三方登录态')
          out.providerCookies = sealed
        } else {
          delete out.providerCookies
        }
        return out
      })
    }))

    const credentials: StoredCredential[] = config.credentials.map((c) => {
      const out: StoredCredential = { ...c }
      if (c.password) {
        const sealed = seal(c.password)
        if (sealed === null) throw new Error('系统加密不可用，已拒绝写入登录密码')
        out.password = sealed
      } else {
        delete out.password
      }
      if (c.totpSecret) {
        const sealed = seal(c.totpSecret)
        if (sealed === null) throw new Error('系统加密不可用，已拒绝写入 TOTP 密钥')
        out.totpSecret = sealed
      } else {
        delete out.totpSecret
      }
      return out
    })

    return { version: CONFIG_VERSION, sites, credentials, settings: config.settings }
  }

  /**
   * 对外读取配置：**不含会话凭据**。
   *
   * 这个方法的结果会被整包经 IPC 发给渲染进程，因此必须裁掉 cookie / token /
   * 第三方登录态备份。主进程内部需要完整数据时用 `getInternal()`。
   * 靠调用方自觉剥离不可靠 —— 多一条账号字段就多一次泄漏机会。
   */
  get(): PublicConfig {
    return toPublicConfig(structuredClone(this.config))
  }

  /** 仅主进程内部使用：包含解密后的会话凭据。 */
  getInternal(): AppConfig {
    return structuredClone(this.config)
  }

  getSettings(): Settings {
    return structuredClone(this.config.settings)
  }

  findSite(siteId: string): Site | undefined {
    return this.config.sites.find((s) => s.id === siteId)
  }

  findAccount(accountId: string): Account | undefined {
    for (const site of this.config.sites) {
      const hit = site.accounts.find((a) => a.id === accountId)
      if (hit) return hit
    }
    return undefined
  }

  /** 读取完整凭据（含密码与 TOTP），只在主进程内部使用。 */
  findCredential(credentialId: string): Credential | undefined {
    return this.config.credentials.find((c) => c.id === credentialId)
  }

  /**
   * 读-改-写：mutator 直接修改传入的实时对象，返回后统一落盘。
   *
   * 返回值是对外视图（不含凭据），因此可以直接回给渲染进程。
   */
  async mutate(mutator: (config: AppConfig) => void): Promise<PublicConfig> {
    mutator(this.config)
    await this.persist()
    this.onChange?.()
    return this.get()
  }

  private async persist(): Promise<void> {
    const stored = this.toStored(this.config)
    const payload = JSON.stringify(stored, null, 2)
    this.writeQueue = this.writeQueue.then(async () => {
      const fs = await import('node:fs/promises')
      const tmp = `${this.configFile}.tmp`
      await fs.writeFile(tmp, payload, 'utf8')
      await fs.rename(tmp, this.configFile)
    })
    return this.writeQueue
  }

  // ---------- 日志 ----------

  getLogs(siteId?: string): LogEntry[] {
    const list = siteId ? this.logs.filter((l) => l.siteId === siteId) : this.logs
    return list.slice(-500).reverse()
  }

  log(
    level: LogLevel,
    scope: string,
    message: string,
    extra?: { siteId?: string; accountId?: string; detail?: string }
  ): void {
    this.logs.push({
      id: randomUUID(),
      at: Date.now(),
      level,
      scope,
      message,
      siteId: extra?.siteId,
      accountId: extra?.accountId,
      detail: extra?.detail
    })
    if (this.logs.length > MAX_LOGS) this.logs = this.logs.slice(-MAX_LOGS)
    void this.flushLogs()
  }

  private flushLogs(): Promise<void> {
    const payload = JSON.stringify(this.logs)
    this.writeQueue = this.writeQueue.then(async () => {
      const fs = await import('node:fs/promises')
      await fs.writeFile(this.logFile, payload, 'utf8').catch(() => undefined)
    })
    return this.writeQueue
  }

  clearLogs(): void {
    this.logs = []
    void this.flushLogs()
  }

  /** 系统加密是否可用，供设置页展示。 */
  static encryptionAvailable(): boolean {
    return encryptionAvailable()
  }
}
