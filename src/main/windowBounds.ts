/**
 * 窗口几何信息的纯计算部分。
 *
 * 单独拆出来是因为它需要覆盖「换了显示器 / 拔掉外接屏 / 分辨率变小」
 * 这些真实会出现的情况，而这些分支不该依赖 Electron 运行时才能验证。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowBounds extends Rect {
  /** 上次关闭时是否处于最大化。 */
  maximized: boolean
}

export interface DisplayWorkArea {
  workArea: Rect
}

export interface WindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/** 至少要露出这么多像素，用户才能抓得到窗口标题栏。 */
const MIN_VISIBLE = 80

const DEFAULT_SIZE: WindowSize = {
  width: 1440,
  height: 900,
  minWidth: 1040,
  minHeight: 640
}

function isFiniteRect(value: Partial<Rect> | null | undefined): value is Rect {
  return (
    !!value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    (value.width as number) > 0 &&
    (value.height as number) > 0
  )
}

/** 与某个显示器工作区重叠的区域是否够大（避免窗口整个跑到屏幕外）。 */
function visibleOn(bounds: Rect, area: Rect): boolean {
  const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const height =
    Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
  return width >= MIN_VISIBLE && height >= MIN_VISIBLE
}

/**
 * 把落盘的窗口位置收敛到当前可用的显示器范围内。
 *
 * - 尺寸不会小于最小尺寸，也不会超出主屏工作区；
 * - 位置如果还能让用户抓到（至少 80px 可见）就原样保留；
 * - 否则（外接屏已拔掉等）在主屏居中重开，而不是把窗口丢在看不见的地方。
 */
export function sanitizeWindowBounds(
  saved: Partial<WindowBounds> | null | undefined,
  displays: DisplayWorkArea[],
  fallback: WindowSize = DEFAULT_SIZE
): WindowBounds {
  const primary = displays[0]?.workArea

  if (!primary) {
    return {
      x: 0,
      y: 0,
      width: fallback.width,
      height: fallback.height,
      maximized: false
    }
  }

  const maxWidth = Math.max(fallback.minWidth, primary.width)
  const maxHeight = Math.max(fallback.minHeight, primary.height)

  const maximized = saved?.maximized === true

  if (isFiniteRect(saved)) {
    const width = Math.min(Math.max(Math.round(saved.width), fallback.minWidth), maxWidth)
    const height = Math.min(Math.max(Math.round(saved.height), fallback.minHeight), maxHeight)
    if (visibleOn(saved, primary) || displays.some((d) => visibleOn(saved, d.workArea))) {
      return {
        x: Math.round(saved.x),
        y: Math.round(saved.y),
        width,
        height,
        maximized
      }
    }
    return {
      x: primary.x + Math.max(0, Math.floor((primary.width - width) / 2)),
      y: primary.y + Math.max(0, Math.floor((primary.height - height) / 2)),
      width,
      height,
      maximized
    }
  }

  const width = Math.min(fallback.width, maxWidth)
  const height = Math.min(fallback.height, maxHeight)
  return {
    x: primary.x + Math.max(0, Math.floor((primary.width - width) / 2)),
    y: primary.y + Math.max(0, Math.floor((primary.height - height) / 2)),
    width,
    height,
    maximized: false
  }
}
