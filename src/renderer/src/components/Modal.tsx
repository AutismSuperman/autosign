import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

interface Props {
  title: React.ReactNode
  onClose: () => void
  /** 提供后，输入框内按 Enter 触发提交（IME 组词中的 Enter 不会误触）。 */
  onSubmit?: () => void
  submitDisabled?: boolean
  wide?: boolean
  /** 标题行右侧的附加内容，例如分段选择器。 */
  headExtra?: React.ReactNode
  children: React.ReactNode
}

/**
 * 对话框外壳：统一标题栏 + 关闭按钮、Esc 关闭、Enter 提交、
 * 打开时自动聚焦首个输入框、背景点击关闭。
 */
export function Modal(props: Props): React.JSX.Element {
  const { title, onClose, onSubmit, submitDisabled, wide, headExtra, children } = props
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const field = root.querySelector<HTMLElement>(
      'input:not([type=hidden]), select, textarea, .zselect'
    )
    // 没有输入框时聚焦容器本身，保证 Esc 等按键能被对话框收到
    if (field) field.focus()
    else root.focus()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (
      e.key === 'Enter' &&
      onSubmit &&
      !submitDisabled &&
      !e.nativeEvent.isComposing &&
      (e.target as HTMLElement).tagName === 'INPUT'
    ) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        ref={ref}
        tabIndex={-1}
        className={wide ? 'modal modal-wide' : 'modal'}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <h2>{title}</h2>
          {headExtra}
          <button
            className="icon-btn modal-x"
            onClick={onClose}
            title="关闭（Esc）"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
