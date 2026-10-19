import { app } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WindowBounds } from './windowBounds'

/**
 * 窗口位置与大小的落盘。
 *
 * 单独存一个文件而不是塞进 config.json：
 *   - 拖动/缩放窗口非常频繁，写配置会连带触发 configChanged 广播，
 *     界面每次都要重新拉一遍配置，既浪费又容易打断正在进行的操作；
 *   - 窗口几何属于本机显示环境，换机器时应当失效，不该跟着配置同步。
 */
export class WindowStateStore {
  private get file(): string {
    return join(app.getPath('userData'), 'window-state.json')
  }

  private pending: NodeJS.Timeout | null = null
  private latest: WindowBounds | null = null
  private writing: Promise<void> = Promise.resolve()
  /**
   * 最近一次的「非最大化」几何。
   *
   * 最大化时 getBounds() 返回的是屏幕尺寸，直接存会让下次取消最大化
   * 变成整屏窗口，因此最大化状态下沿用这里的值。
   */
  lastNormal: Omit<WindowBounds, 'maximized'> | null = null

  async read(): Promise<WindowBounds | null> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<WindowBounds>
      if (
        typeof parsed.x !== 'number' ||
        typeof parsed.y !== 'number' ||
        typeof parsed.width !== 'number' ||
        typeof parsed.height !== 'number'
      ) {
        return null
      }
      return {
        x: parsed.x,
        y: parsed.y,
        width: parsed.width,
        height: parsed.height,
        maximized: parsed.maximized === true
      }
    } catch {
      // 首次启动或文件损坏：交给上层用默认值
      return null
    }
  }

  /** 记录最新几何信息；写盘合并到一次，避免拖动时每帧都写文件。 */
  schedule(bounds: WindowBounds): void {
    this.latest = bounds
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      void this.flush()
    }, 400)
  }

  /** 立即落盘（退出前调用，保证最后一次调整不丢）。 */
  async flush(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending)
      this.pending = null
    }
    const bounds = this.latest
    if (!bounds) return
    this.latest = null
    const payload = JSON.stringify(bounds)
    const tmp = `${this.file}.tmp`
    this.writing = this.writing.then(async () => {
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.file)
    })
    await this.writing.catch(() => undefined)
  }

  /**
   * 退出流程专用：进程随时会被结束，异步写可能来不及完成，
   * 因此这里同步写入。
   */
  flushSync(): void {
    if (this.pending) {
      clearTimeout(this.pending)
      this.pending = null
    }
    const bounds = this.latest
    if (!bounds) return
    this.latest = null
    try {
      writeFileSync(this.file, JSON.stringify(bounds), 'utf8')
    } catch {
      // 写失败不影响退出
    }
  }
}
