/**
 * 隐藏窗口的生命周期管理。
 *
 * 三处功能（Turnstile 取令牌、静默重授权、手动 OAuth）都要开一个 `show: false`
 * 的 BrowserWindow，各自写了一遍 `settled` 闸门 + `destroy()` + deadline 计时器。
 * 三份实现都漏了同样的东西，而且漏法各不相同：
 *
 *   - `turnstile.ts` 的清理只在 `Promise.race` 之后调用，`work` 一旦 reject
 *     就跳过了清理（`getURL()` 在窗口被销毁时会抛），窗口永久泄漏
 *   - `silentReauth.ts` / `oauth.ts` 把 deadline 计时器留到自然触发，
 *     成功后仍攥着已销毁窗口的闭包
 *   - `oauth.ts` 干脆没有硬超时：用户不理会窗口，Promise 就一直 pending
 *
 * 这里把「开窗口 → 跑任务 → 无论如何都清理」收成一条路径，让上面这些
 * 不可能再各写一遍。
 *
 * 设计约束：
 *   1. **任何出口都清理**：正常返回、超时、任务抛错、窗口被外部关闭，
 *      四条路径都保证 `destroy()` 与 `clearTimeout`
 *   2. 清理必须幂等：`closed` 事件回调与主动 destroy 会撞车
 *   3. 失败必须给出**类型正确的**兜底值，绝不吞成 undefined
 */

import type { BrowserWindow } from 'electron'

/** 任务没能正常返回的原因。 */
export type HiddenWindowAbortReason = 'timeout' | 'closed' | 'error'

/** 隐藏窗口的创建参数。 */
export interface HiddenWindowOptions<T> {
  /** 调试用标识，写进日志，便于定位是哪个窗口出的问题。 */
  label: string
  /** 实际创建窗口。由调用方提供，便于测试注入假窗口。 */
  create: () => BrowserWindow
  /** 硬超时。到点强制结束。 */
  timeoutMs: number
  /**
   * 兜底结果。超时、窗口被外部关闭、任务抛错时都用它生成返回值。
   *
   * 要求调用方显式给出，而不是返回 `undefined as T`：隐藏窗口的结果类型
   * 都带错误信息，静默返回 undefined 会让上层拿不到任何可展示的原因。
   */
  fallback: (reason: HiddenWindowAbortReason, detail?: string) => T
  /** 日志出口；不提供时静默。用于记录清理异常等不该打断主流程的事情。 */
  log?: (message: string, detail?: string) => void
}

/** 供任务体使用的句柄。 */
export interface HiddenWindowHandle {
  /** 当前窗口。 */
  win: BrowserWindow
  /**
   * 任务是否已被外部结束（超时 / 窗口关闭）。
   * 任务体在每次 await 之后都该查一下，避免在已销毁的窗口上操作。
   */
  aborted: () => boolean
  /** 提前结束并返回结果。 */
  settle: (value: unknown) => void
  /**
   * 重置超时窗口。
   *
   * 给「窗口已交还给用户」的场景用：交互式授权把窗口显示出来之后，
   * 等待的主体就不再是机器而是人，原来的 45 秒/70 秒预算没有意义。
   * 调用后从此刻重新计时。
   */
  extend: (ms: number) => void
}

/**
 * 在隐藏窗口里执行一段任务，并保证窗口一定被清理。
 *
 * @param opts 窗口创建参数、超时与兜底策略
 * @param work 任务体。拿到句柄后自行导航、注入脚本；返回值即最终结果。
 *
 * 返回值的优先级：任务体先给出结果就采用；否则由超时 / 关闭 / 异常
 * 通过 `fallback` 生成。任务体的异常**不会**让 Promise reject ——
 * 那正是原来导致窗口泄漏的根源。
 */
export function withHiddenWindow<T>(
  opts: HiddenWindowOptions<T>,
  work: (h: HiddenWindowHandle) => Promise<T>
): Promise<T> {
  const win = opts.create()
  const log = opts.log ?? ((): void => {})

  return new Promise<T>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const destroy = (): void => {
      try {
        if (!win.isDestroyed()) win.destroy()
      } catch (e) {
        // 窗口可能已被外部回收：清理失败不该影响结果
        log(`隐藏窗口 ${opts.label} 销毁失败`, e instanceof Error ? e.message : String(e))
      }
    }

    const settleWith = (value: T): void => {
      if (settled) return
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      destroy()
      resolve(value)
    }

    timer = setTimeout(() => settleWith(opts.fallback('timeout')), opts.timeoutMs)
    // 后台任务不该阻止进程退出
    ;(timer as unknown as { unref?: () => void }).unref?.()

    /** 重新计时：停掉旧计时器，按新预算再挂一个。 */
    const extend = (ms: number): void => {
      if (settled) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => settleWith(opts.fallback('timeout')), ms)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    }

    // 窗口被外部关闭（用户点 X、系统回收）：立刻结束，不让 Promise 挂起
    win.once('closed', () => {
      if (settled) return
      settleWith(opts.fallback('closed'))
    })

    const handle: HiddenWindowHandle = {
      win,
      aborted: () => settled,
      settle: (value) => settleWith(value as T),
      extend
    }

    // 任务体即使在 await 之后抛错，也必须走到 settle —— 否则窗口泄漏
    void work(handle).then(
      (value) => settleWith(value),
      (e) => {
        const detail = e instanceof Error ? e.message : String(e)
        log(`隐藏窗口 ${opts.label} 任务异常`, detail)
        settleWith(opts.fallback('error', detail))
      }
    )
  })
}

/**
 * 安全地读当前 URL。
 *
 * `webContents.getURL()` 在窗口已销毁时会抛错 —— 原实现把它放在
 * `Promise.race` 的任务体里且没有 try/catch，于是任务体 reject、
 * 清理被跳过。所有读 URL 的地方统一走这里。
 */
export function safeCurrentUrl(win: BrowserWindow): string {
  try {
    if (win.isDestroyed()) return ''
    return win.webContents.getURL() || ''
  } catch {
    return ''
  }
}
