/**
 * 账号打码的文本处理。
 *
 * 打码分两层：
 *   - 结构性数据（账号名、凭据用户名）：直接渲染遮罩块，原文不进 DOM；
 *   - 日志正文这种主进程拼好的整句：没法从文本判断哪一段是账号，
 *     所以拿已知的账号标识做字面量匹配，切成「普通文字 / 遮罩」片段。
 *
 * 这里只做切分，不产出字符串——原始账号字符不会出现在输出里，
 * 截图或查看元素都拿不到。
 */

export interface TextSegment {
  kind: 'text' | 'mask'
  /** kind=text 时是要显示的文字；kind=mask 时是遮罩的宽度参照（原文）。 */
  value: string
}

/**
 * 把一段文字按已知账号标识切开。
 *
 * - 长串优先：`user` 与 `user_123` 同时存在时先匹配后者，
 *   否则会把长串切成 `user` + `_123`，后半段反而露出来；
 * - 相同位置取最长命中；
 * - 没有命中时整段原样返回，避免产生大量无意义的单段数组。
 */
export function splitByIdentifiers(
  text: string,
  identifiers: readonly string[]
): TextSegment[] {
  const ids = identifiers
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length)

  if (text.length === 0) return []
  if (ids.length === 0) return [{ kind: 'text', value: text }]

  const out: TextSegment[] = []
  let rest = text

  while (rest.length > 0) {
    let hitAt = -1
    let hitId = ''
    for (const id of ids) {
      const at = rest.indexOf(id)
      if (at < 0) continue
      // 更靠前优先；同一位置取更长的（ids 已按长度降序，严格小于才替换）
      if (hitAt < 0 || at < hitAt || (at === hitAt && id.length > hitId.length)) {
        hitAt = at
        hitId = id
      }
    }

    if (hitAt < 0) {
      out.push({ kind: 'text', value: rest })
      break
    }
    if (hitAt > 0) out.push({ kind: 'text', value: rest.slice(0, hitAt) })
    out.push({ kind: 'mask', value: hitId })
    rest = rest.slice(hitAt + hitId.length)
  }

  return out
}

/** 该文本里是否出现过任一账号标识（用于决定要不要走切分渲染）。 */
export function containsIdentifier(text: string, identifiers: readonly string[]): boolean {
  return identifiers.some((id) => id.trim().length > 0 && text.includes(id.trim()))
}
