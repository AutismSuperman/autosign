import { useCallback, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Modal } from './Modal'

export interface ConfirmOptions {
  title: string
  message?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作（删除、清空）时确认按钮显示为红色。 */
  danger?: boolean
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

/**
 * Promise 化的确认对话框：
 *
 *   const { confirm, dialog } = useConfirm()
 *   if (await confirm({ title: '移除站点？', danger: true })) …
 *   return <>…{dialog}</>
 *
 * 所有破坏性操作（移除站点/账号、删除凭据、清空日志）都应先过这里。
 */
export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  dialog: React.JSX.Element | null
} {
  const [state, setState] = useState<ConfirmState | null>(null)

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ ...opts, resolve })
      }),
    []
  )

  const settle = (ok: boolean): void => {
    setState((cur) => {
      cur?.resolve(ok)
      return null
    })
  }

  const dialog = state ? (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {state.danger && <TriangleAlert size={16} style={{ color: 'var(--err)' }} />}
          {state.title}
        </span>
      }
      onClose={() => settle(false)}
    >
      {state.message && <div className="confirm-body">{state.message}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={() => settle(false)}>
          {state.cancelLabel ?? '取消'}
        </button>
        <button
          className={state.danger ? 'btn danger' : 'btn primary'}
          onClick={() => settle(true)}
        >
          {state.confirmLabel ?? '确认'}
        </button>
      </div>
    </Modal>
  ) : null

  return { confirm, dialog }
}
