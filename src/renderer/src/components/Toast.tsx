import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleCheck, CircleX, Info, X } from 'lucide-react'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
  leaving: boolean
}

const LIFETIME_MS = 3400
const LEAVE_MS = 180
const MAX_VISIBLE = 4

/**
 * Toast 队列：可堆叠、分类型（成功/失败/信息）、可手动关闭。
 *
 * 每个条目有自己的定时器，互不干扰；关闭时先播放离场动画再移除。
 */
export function useToasts(): {
  toasts: ToastItem[]
  showToast: (message: string, kind?: ToastKind) => void
  dismiss: (id: number) => void
} {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef(new Map<number, number>())
  const seq = useRef(0)

  const clearTimer = useCallback((id: number) => {
    const t = timers.current.get(id)
    if (t !== undefined) {
      window.clearTimeout(t)
      timers.current.delete(id)
    }
  }, [])

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id)
      setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
      window.setTimeout(() => {
        setToasts((list) => list.filter((t) => t.id !== id))
      }, LEAVE_MS)
    },
    [clearTimer]
  )

  const showToast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++seq.current
      setToasts((list) => [...list, { id, kind, message, leaving: false }].slice(-MAX_VISIBLE))
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), LIFETIME_MS)
      )
    },
    [dismiss]
  )

  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) window.clearTimeout(t)
      map.clear()
    }
  }, [])

  return { toasts, showToast, dismiss }
}

const KIND_ICON: Record<ToastKind, typeof Info> = {
  success: CircleCheck,
  error: CircleX,
  info: Info
}

export function ToastHost({
  toasts,
  onDismiss
}: {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}): React.JSX.Element | null {
  if (toasts.length === 0) return null
  return (
    <div className="toast-stack">
      {toasts.map((t) => {
        const Icon = KIND_ICON[t.kind]
        return (
          <div key={t.id} className={`toast ${t.kind}${t.leaving ? ' leaving' : ''}`}>
            <span className="toast-icon">
              <Icon size={16} />
            </span>
            <span className="toast-msg">{t.message}</span>
            <button
              className="toast-close"
              onClick={() => onDismiss(t.id)}
              aria-label="关闭提示"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
