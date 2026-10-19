/** 复制到剪贴板；渲染进程内 navigator.clipboard 始终可用，失败时返回 false。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
