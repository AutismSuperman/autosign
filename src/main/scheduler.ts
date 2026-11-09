import type { ScheduleSettings } from '../shared/types'
import { rewardDate } from './sites/profile'

/** Same-day retry delays after a scheduled attempt fails. */
export const SCHEDULE_RETRY_DELAYS_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000] as const

export function scheduleTimeOf(
  settings: Pick<ScheduleSettings, 'time'>
): { hour: number; minute: number } | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(settings.time)
  if (!match) return undefined
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

function isWeekday(date: Date): boolean {
  const day = date.getDay()
  return day !== 0 && day !== 6
}

/** Whether today's scheduled time has passed and today is eligible. */
export function scheduleDueToday(now: Date, settings: ScheduleSettings): boolean {
  if (!settings.enabled) return false
  const time = scheduleTimeOf(settings)
  if (!time) return false
  if (settings.weekdaysOnly && !isWeekday(now)) return false
  const today = new Date(now)
  today.setHours(time.hour, time.minute, 0, 0)
  return today.getTime() <= now.getTime()
}

/** Calculate the next eligible local wall-clock execution time. */
export function nextScheduleAt(now: Date, settings: ScheduleSettings): number | undefined {
  if (!settings.enabled) return undefined
  const time = scheduleTimeOf(settings)
  if (!time) return undefined

  const next = new Date(now)
  next.setHours(time.hour, time.minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  if (settings.weekdaysOnly) {
    while (!isWeekday(next)) next.setDate(next.getDate() + 1)
  }
  return next.getTime()
}

export function scheduleRetryDelay(retryIndex: number): number | undefined {
  return SCHEDULE_RETRY_DELAYS_MS[retryIndex]
}

/** Clamp long waits so a timer never exceeds Node's signed 32-bit timeout. */
export function timerDelay(targetAt: number, now = Date.now()): number {
  return Math.max(0, Math.min(targetAt - now, 2 ** 31 - 1))
}

export interface ScheduledAccount {
  id: string
  checked: boolean
  /** Some sites open their daily claim window later than midnight. */
  notBefore?: number
}

export interface ScheduleAttempt {
  attempts: number
  status: 'pending' | 'done' | 'blocked' | 'exhausted'
  nextAt: number
}

export interface ScheduleState {
  date: string
  accounts: Record<string, ScheduleAttempt>
}

export interface ScheduleSummary {
  succeeded: number
  retrying: number
  stopped: number
}

export interface SchedulerDeps {
  settings: () => ScheduleSettings
  accounts: (now: number) => ScheduledAccount[]
  checkin: (accountId: string) => Promise<{ ok: boolean; message: string }>
  save: (state: ScheduleState) => Promise<void>
  online: () => boolean
  log: (level: 'info' | 'ok' | 'warn' | 'err', message: string, accountId?: string) => void
  notify: (summary: ScheduleSummary) => void
  now?: () => number
}

/** Only explicit permanent/manual failures stop retries; transient WAF errors do not. */
export function needsManualCheckin(message: string): boolean {
  return /人工|手动.*(?:验证|签到)|设备验证|没有保存密码|未保存密码|未关联凭据|凭据已被删除|用户名或密码错误|密码错误|会话数已达上限|AUTH_SESSION_LIMIT|仅支持网页|没有可用的签到端点|不支持重登签到|未登记.*回调|身份.*不一致/.test(message)
}

/**
 * A persisted per-account queue. A short wall-clock check also covers clock changes
 * and network recovery; resume/settings events can request an immediate check.
 */
export class CheckinScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopped = true
  private generation = 0
  private state: ScheduleState
  private readonly now: () => number

  constructor(private readonly deps: SchedulerDeps, initial?: ScheduleState) {
    this.now = deps.now ?? Date.now
    this.state = initial ? structuredClone(initial) : { date: '', accounts: {} }
  }

  start(): void {
    this.stopped = false
    this.changed()
  }

  /** Cancel obsolete timers immediately; an active account finishes before replanning. */
  changed(): void {
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.stopped && !this.running && this.deps.settings().enabled) this.arm(0)
  }

  stop(): void {
    this.stopped = true
    this.changed()
  }

  private arm(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, delay)
    this.timer.unref?.()
  }

  /** Public for deterministic tests and resume events; concurrent calls share the run. */
  tick(): Promise<void> {
    if (this.running) return this.running
    if (this.stopped) return Promise.resolve()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const generation = this.generation
    const task = Promise.resolve().then(() => this.run(generation)).catch(() => {
      this.deps.log('err', '调度状态保存或执行失败，稍后重新检查')
    })
    this.running = task.finally(() => {
      this.running = undefined
      if (!this.stopped && this.deps.settings().enabled) {
        this.arm(generation !== this.generation ? 0 : this.nextDelay())
      }
    })
    return this.running
  }

  private nextDelay(): number {
    const now = this.now()
    const settings = this.deps.settings()
    const daily = nextScheduleAt(new Date(now), settings)
    let delay = daily === undefined ? 60_000 : Math.min(60_000, timerDelay(daily, now))
    if (scheduleDueToday(new Date(now), settings) && this.deps.online()) {
      for (const entry of Object.values(this.state.accounts)) {
        if (entry.status === 'pending' && entry.nextAt > now) {
          delay = Math.min(delay, entry.nextAt - now)
        }
      }
    }
    return Math.max(1000, delay)
  }

  private async run(generation: number): Promise<void> {
    const now = this.now()
    if (this.stopped || !scheduleDueToday(new Date(now), this.deps.settings())) return
    if (!this.deps.online()) return
    const date = rewardDate(now)
    if (this.state.date !== date) this.state = { date, accounts: {} }
    const accounts = this.deps.accounts(now)
    const currentIds = new Set(accounts.map((account) => account.id))
    for (const id of Object.keys(this.state.accounts)) {
      if (!currentIds.has(id)) delete this.state.accounts[id]
    }

    let attempted = 0
    let succeeded = 0
    for (const account of accounts) {
      if (this.stopped || generation !== this.generation || !this.deps.online()) break
      if (rewardDate(this.now()) !== date ||
          !scheduleDueToday(new Date(this.now()), this.deps.settings())) break
      const fresh = this.deps.accounts(this.now()).find((item) => item.id === account.id)
      if (!fresh || fresh.checked || (fresh.notBefore !== undefined && fresh.notBefore > this.now())) continue
      const entry = this.state.accounts[account.id]
      if (entry && (entry.status !== 'pending' || entry.nextAt > this.now())) continue

      const attempts = (entry?.attempts ?? 0) + 1
      if (attempts > SCHEDULE_RETRY_DELAYS_MS.length + 1) {
        this.state.accounts[account.id] = { attempts: attempts - 1, status: 'exhausted', nextAt: 0 }
        await this.deps.save(structuredClone(this.state))
        continue
      }
      // Persist before sending: a crash must not restart a fast, unlimited retry loop.
      this.state.accounts[account.id] = {
        attempts, status: 'pending',
        nextAt: this.now() + (scheduleRetryDelay(attempts - 1) ?? 20 * 60_000)
      }
      try {
        await this.deps.save(structuredClone(this.state))
      } catch (error) {
        if (entry) this.state.accounts[account.id] = entry
        else delete this.state.accounts[account.id]
        throw error
      }
      if (this.stopped || generation !== this.generation || !this.deps.online() ||
          rewardDate(this.now()) !== date) {
        if (entry) this.state.accounts[account.id] = entry
        else delete this.state.accounts[account.id]
        await this.deps.save(structuredClone(this.state))
        break
      }
      this.deps.log('info', `自动签到：第 ${attempts} 次尝试`, account.id)
      attempted++
      let result: { ok: boolean; message: string }
      try {
        result = await this.deps.checkin(account.id)
      } catch {
        result = { ok: false, message: '账号签到发生异常，本轮已跳过，稍后重试' }
      }
      const retryDelay = scheduleRetryDelay(attempts - 1)
      const status = result.ok ? 'done'
        : needsManualCheckin(result.message) ? 'blocked'
          : retryDelay === undefined ? 'exhausted' : 'pending'
      this.state.accounts[account.id] = {
        attempts, status, nextAt: status === 'pending' ? this.now() + retryDelay! : 0
      }
      await this.deps.save(structuredClone(this.state))
      if (result.ok) succeeded++
      this.deps.log(
        result.ok ? 'ok' : 'warn',
        result.ok ? '自动签到成功'
          : status === 'pending' ? `自动签到未成功，${retryDelay! / 60_000} 分钟后核对并重试`
            : status === 'blocked' ? '自动签到需要人工处理，停止该账号今天的自动重试'
              : '自动签到已达到当天重试上限，请查看运行日志',
        account.id
      )
    }
    if (attempted > 0) {
      const remaining = this.deps.accounts(this.now()).filter((account) => !account.checked)
      this.deps.notify({
        succeeded,
        retrying: remaining.filter((account) => this.state.accounts[account.id]?.status === 'pending').length,
        stopped: remaining.filter((account) => {
          const status = this.state.accounts[account.id]?.status
          return status === 'blocked' || status === 'exhausted'
        }).length
      })
    }
  }
}
