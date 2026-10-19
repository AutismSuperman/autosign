import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

interface Props<T extends string> {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
  /** 供读屏使用；触发器没有可见标签时必须提供。 */
  ariaLabel: string
  title?: string
  size?: 'sm' | 'md'
  minWidth?: number
  className?: string
  disabled?: boolean
}

interface Placement {
  left: number
  top: number
  width: number
  placement: 'below' | 'above'
}

/** 触发器与菜单之间的间距。 */
const GAP = 6
/** 菜单与窗口边缘的最小留白。 */
const EDGE = 8

function samePlacement(a: Placement | null, b: Placement): boolean {
  return (
    !!a &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.placement === b.placement
  )
}

/**
 * 自绘下拉选择。
 *
 * 原生 <select> 的弹出层由操作系统绘制，深色界面里会突然出现一块
 * 白底蓝条的系统菜单。这里改用 portal + fixed 定位自绘列表，
 * 与应用的配色、圆角和阴影保持一致；同时保留 combobox/listbox 语义与
 * 方向键、Home/End、Enter、Esc 的键盘操作。
 *
 * 菜单挂在 body 上，避免被 .content / .modal 的 overflow 裁掉；
 * 打开期间跟随滚动与窗口尺寸重新定位。
 */
export function Select<T extends string>(props: Props<T>): React.JSX.Element {
  const {
    value,
    options,
    onChange,
    ariaLabel,
    title,
    size = 'md',
    minWidth,
    className,
    disabled
  } = props
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<Placement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )
  const selected = options[selectedIndex]

  const applyPos = useCallback((next: Placement): void => {
    setPos((prev) => (samePlacement(prev, next) ? prev : next))
  }, [])

  /** 以触发器的位置为基准摆放菜单：优先向下，空间不足时翻到上方。 */
  const place = useCallback((): void => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const menuH = menuRef.current?.offsetHeight ?? 0
    const fallbackWidth = size === 'sm' ? 140 : 180
    const width = Math.min(
      Math.max(rect.width, minWidth ?? fallbackWidth),
      window.innerWidth - EDGE * 2
    )
    const left = Math.min(
      Math.max(rect.left, EDGE),
      Math.max(EDGE, window.innerWidth - width - EDGE)
    )
    const below = rect.bottom + GAP
    const above = rect.top - menuH - GAP
    const openUp = menuH > 0 && below + menuH > window.innerHeight - EDGE && above >= EDGE
    const top = openUp
      ? above
      : Math.min(below, Math.max(EDGE, window.innerHeight - menuH - EDGE))
    applyPos({ left, top, width, placement: openUp ? 'above' : 'below' })
  }, [applyPos, minWidth, size])

  // 菜单先以隐藏态挂载，量到真实高度后再定位并显示。
  // 首帧即定好位置，避免先向下展开再向上跳一下。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
  }, [open, place])

  // 滚动（含内部容器）与窗口尺寸变化时重新贴住触发器
  useEffect(() => {
    if (!open) return
    const sync = (): void => place()
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [open, place])

  // 点击组件以外的地方收起
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onWindowBlur = (): void => setOpen(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [open])

  // 键盘移动高亮项时让它保持在可视范围内
  useLayoutEffect(() => {
    if (!open) return
    const item = menuRef.current?.children[active] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const toggle = (): void => {
    if (disabled) return
    if (open) {
      setOpen(false)
      return
    }
    setActive(selectedIndex)
    setOpen(true)
  }

  const choose = (index: number): void => {
    const option = options[index]
    if (!option) return
    setOpen(false)
    triggerRef.current?.focus()
    if (option.value !== value) onChange(option.value)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        if (!open) {
          setActive(selectedIndex)
          setOpen(true)
          return
        }
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setActive((prev) => (prev + delta + options.length) % options.length)
        return
      }
      case 'Home':
        if (!open) return
        e.preventDefault()
        setActive(0)
        return
      case 'End':
        if (!open) return
        e.preventDefault()
        setActive(options.length - 1)
        return
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (!open) {
          setActive(selectedIndex)
          setOpen(true)
          return
        }
        choose(active)
        return
      case 'Escape':
        if (!open) return
        e.preventDefault()
        // 只收起下拉，不再冒泡去关闭外层对话框
        e.stopPropagation()
        setOpen(false)
        return
      case 'Tab':
        if (open) setOpen(false)
    }
  }

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={`zselect-menu${pos?.placement === 'above' ? ' above' : ''}${
            size === 'sm' ? ' zselect-menu-sm' : ''
          }`}
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            width: pos?.width,
            // 首帧先按隐藏态参与布局，量到真实高度后再定位显示
            visibility: pos ? 'visible' : 'hidden',
            transformOrigin: pos?.placement === 'above' ? 'bottom' : 'top'
          }}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            return (
              <button
                key={option.value}
                id={`${listId}-opt-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                className={`zselect-option${isSelected ? ' is-selected' : ''}${
                  index === active ? ' is-active' : ''
                }`}
                // 焦点留在触发器上，鼠标悬停不打断键盘操作
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <span className="zselect-option-label">{option.label}</span>
                {isSelected && <Check size={13} className="zselect-check" />}
              </button>
            )
          })}
        </div>,
        document.body
      )
    : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`zselect${size === 'sm' ? ' zselect-sm' : ''}${open ? ' open' : ''}${
          className ? ` ${className}` : ''
        }`}
        style={minWidth ? { minWidth } : undefined}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && options[active] ? `${listId}-opt-${active}` : undefined
        }
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span className="zselect-value">{selected?.label ?? ''}</span>
        <ChevronDown size={size === 'sm' ? 13 : 14} className="zselect-chevron" />
      </button>
      {menu}
    </>
  )
}
