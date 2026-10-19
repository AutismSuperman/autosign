import type { ThemeMode } from '@shared/types'

/**
 * 主题应用：把 ThemeMode 解析成实际的 dark/light，
 * 写到 <html data-theme> 上，styles.css 的 token 组随之切换。
 */

export type ResolvedTheme = 'dark' | 'light'

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(mode)
}

/**
 * 跟随系统时监听系统主题变化；返回取消监听函数。
 * mode 不是 system 时监听器为空操作。
 */
export function watchSystemTheme(mode: ThemeMode, onChange: () => void): () => void {
  if (mode !== 'system') return () => {}
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
