import { useLayoutEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface SegItem<T extends string> {
  key: T
  label: string
  icon?: LucideIcon
}

interface Props<T extends string> {
  value: T
  items: Array<SegItem<T>>
  onChange: (key: T) => void
  ariaLabel?: string
}

/**
 * 分段选择器：轨道 + 测量定位的滑动 thumb。
 *
 * thumb 只承担选中态的视觉（底色 + 发丝描边阴影），pointer-events 为 none，
 * 点击与脚本断言都直达 .seg-item 按钮本身。
 */
export function Seg<T extends string>(props: Props<T>): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  const [ready, setReady] = useState(false)

  const place = (): void => {
    const root = rootRef.current
    const thumb = thumbRef.current
    if (!root || !thumb) return
    const index = props.items.findIndex((i) => i.key === props.value)
    const active = root.querySelectorAll<HTMLButtonElement>('.seg-item')[index]
    if (!active) return
    thumb.style.width = `${active.offsetWidth}px`
    thumb.style.transform = `translateX(${active.offsetLeft}px)`
  }

  useLayoutEffect(() => {
    place()
    // 首帧只定位不过渡，避免 thumb 从 0 宽度滑入
    if (!ready) {
      const id = requestAnimationFrame(() => setReady(true))
      return () => cancelAnimationFrame(id)
    }
  }, [props.value, props.items.length, ready])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ro = new ResizeObserver(() => place())
    ro.observe(root)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="seg" ref={rootRef} role="group" aria-label={props.ariaLabel}>
      <span
        className="seg-thumb"
        aria-hidden="true"
        ref={thumbRef}
        style={ready ? undefined : { transition: 'none' }}
      />
      {props.items.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.key}
            type="button"
            className={props.value === item.key ? 'seg-item active' : 'seg-item'}
            onClick={() => props.onChange(item.key)}
          >
            {Icon ? <Icon size={13} /> : null}
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
