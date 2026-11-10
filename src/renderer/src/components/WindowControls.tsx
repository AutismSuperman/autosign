import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import type { WindowChromeState } from '@shared/window'

export function useWindowChrome(): WindowChromeState | undefined {
  const [state, setState] = useState<WindowChromeState>()
  useEffect(() => {
    let alive = true
    void window.windowControls.state().then((next) => { if (alive) setState(next) })
    const unsubscribe = window.windowControls.onChange(setState)
    return () => { alive = false; unsubscribe() }
  }, [])
  return state
}

export function WindowControls(): React.JSX.Element {
  const state = useWindowChrome()
  const restore = state?.maximized || state?.fullScreen
  return (
    <div className="window-controls" aria-label="窗口操作">
      <button className="window-control" title="最小化" aria-label="最小化"
        onClick={() => void window.windowControls.command('minimize')}>
        <Minus size={16} />
      </button>
      <button className="window-control" title={restore ? '还原窗口' : '最大化'}
        aria-label={restore ? '还原窗口' : '最大化'}
        onClick={() => void window.windowControls.command('toggleMaximize')}>
        {restore ? <Copy size={14} /> : <Square size={14} />}
      </button>
      <button className="window-control window-close" title="关闭窗口" aria-label="关闭窗口"
        onClick={() => void window.windowControls.command('close')}>
        <X size={17} />
      </button>
    </div>
  )
}
