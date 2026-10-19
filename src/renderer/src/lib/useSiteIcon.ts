import { useEffect, useState } from 'react'

/**
 * 站点图标 hook。
 *
 * 图标由主进程抓取并通过 data URL 返回（渲染层 CSP 只允许 self 与 data:）。
 * 这里做两层去重：
 *   - 进程内按地址缓存结果，避免同一站点在侧栏、卡片、对话框里各请求一次
 *   - 抓取中的地址记下来，并发调用只发一次请求
 *
 * 抓不到时返回 undefined，调用方回退到「首字母」头像。
 */

const cache = new Map<string, string | undefined>()
const inflight = new Map<string, Promise<string | undefined>>()

async function load(url: string): Promise<string | undefined> {
  if (cache.has(url)) return cache.get(url)
  const pending = inflight.get(url)
  if (pending) return pending

  const task = window.api.config
    .icon(url)
    .catch(() => undefined)
    .then((data) => {
      cache.set(url, data)
      inflight.delete(url)
      return data
    })
  inflight.set(url, task)
  return task
}

/** 返回该站点的图标 data URL；加载中与失败时都是 undefined。 */
export function useSiteIcon(baseUrl: string | undefined): string | undefined {
  const [icon, setIcon] = useState<string | undefined>(() =>
    baseUrl ? cache.get(baseUrl) : undefined
  )

  useEffect(() => {
    if (!baseUrl) {
      setIcon(undefined)
      return
    }
    let alive = true
    void load(baseUrl).then((data) => {
      if (alive) setIcon(data)
    })
    return () => {
      alive = false
    }
  }, [baseUrl])

  return icon
}
