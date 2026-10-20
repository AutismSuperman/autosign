/**
 * 「已经提示过哪些版本」的本地记录。
 *
 * 后台检查每 6 小时跑一次。如果每个版本每次发现都弹通知，
 * 一个放着不管的版本一周会打扰用户近 30 次；但完全不提示，
 * 用户又不知道有新版本。折中做法是**每个版本只主动提示一次**：
 * 提示过后不再打扰，设置页里仍然一直有入口。
 *
 * 这个文件只存内部状态，与用户可见的配置（config.json）分开，
 * 避免把实现细节暴露成对外的配置字段。
 */
import { readFile, writeFile, rename } from 'node:fs/promises'

interface NotifyState {
  /** 最近一次主动提示过的版本号。 */
  lastNotifiedVersion?: string
}

export class NotifyStateStore {
  private state: NotifyState = {}
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as NotifyState
      if (parsed && typeof parsed === 'object') this.state = parsed
    } catch {
      // 文件不存在或损坏都按「没提示过」处理，不影响主流程
      this.state = {}
    }
  }

  /**
   * 判断某个版本是否需要主动提示。
   *
   * 只做判断、不落盘：真正弹出后再调用 markNotified。
   * 这样弹窗因故没弹出来时不会白白吞掉一次提示。
   */
  shouldNotify(version: string): boolean {
    return this.state.lastNotifiedVersion !== version
  }

  async markNotified(version: string): Promise<void> {
    this.state.lastNotifiedVersion = version
    await this.persist()
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify(this.state, null, 2)
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.file)
    })
    return this.writeQueue
  }
}
