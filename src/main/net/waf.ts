/**
 * 阿里云 ESA（acw_sc__v2）质询页的解析与求解。
 *
 * 移植自上游 AutoSign WafChallenge.java（AGPL-3.0-or-later）。
 * 算法：arg1 按固定置换表重排 → 与固定密钥逐字节 XOR → 40 位十六进制。
 * 纯计算，不依赖浏览器。
 */

const PERM = [
  0xf, 0x23, 0x1d, 0x18, 0x21, 0x10, 0x1, 0x26, 0xa, 0x9, 0x13, 0x1f, 0x28, 0x1b, 0x16, 0x17,
  0x19, 0xd, 0x6, 0xb, 0x27, 0x12, 0x14, 0x8, 0xe, 0x15, 0x20, 0x1a, 0x2, 0x1e, 0x7, 0x4, 0x11,
  0x5, 0x3, 0x1c, 0x22, 0x25, 0xc, 0x24
]

const KEY = '3000176000856006061501533003690027800375'
const ARG1_RE = /var\s+arg1\s*=\s*'([0-9A-Fa-f]+)'/

/** 响应体是否为 WAF 质询页。 */
export function isChallenge(body: string): boolean {
  return !!body && ARG1_RE.test(body)
}

/** 从质询页正文提取 arg1；无则返回空串。 */
export function arg1(body: string): string {
  const m = ARG1_RE.exec(body)
  return m ? m[1] : ''
}

/** arg1 → acw_sc__v2。任何异常返回空串。 */
export function solve(arg1Value: string): string {
  if (!arg1Value) return ''
  try {
    const q = new Array<string>(arg1Value.length).fill('')
    for (let x = 0; x < arg1Value.length; x++) {
      for (let z = 0; z < PERM.length; z++) {
        if (PERM[z] === x + 1) {
          q[z] = arg1Value.charAt(x)
          break
        }
      }
    }
    const u = q.join('')
    const ln = Math.min(u.length, KEY.length)
    let out = ''
    for (let i = 0; i + 1 < ln; i += 2) {
      const a = parseInt(u.slice(i, i + 2), 16) ^ parseInt(KEY.slice(i, i + 2), 16)
      out += a.toString(16).padStart(2, '0')
    }
    return out
  } catch {
    return ''
  }
}

/** 从 Set-Cookie 串里取指定 cookie 的值。 */
export function pickCookieValue(setCookie: string | null, name: string): string {
  if (!setCookie || !name) return ''
  const m = new RegExp(`(?:^|[;,\\s])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;,\\s]+)`).exec(
    setCookie
  )
  return m ? m[1] : ''
}

/** 把 acw_sc__v2 合并进既有 Cookie：同键覆盖、异键追加。 */
export function mergeAcwScV2(existing: string | undefined, acwScV2: string): string {
  if (!acwScV2 || !/^[0-9a-f]+$/.test(acwScV2)) return existing ?? ''
  const parts = (existing ?? '').split(';').map((p) => p.trim()).filter(Boolean)
  const out: string[] = []
  let replaced = false
  for (const part of parts) {
    if (part.startsWith('acw_sc__v2=')) {
      if (!replaced) {
        out.push(`acw_sc__v2=${acwScV2}`)
        replaced = true
      }
    } else {
      out.push(part)
    }
  }
  if (!replaced) out.push(`acw_sc__v2=${acwScV2}`)
  return out.join('; ')
}

/** 合并 acw_sc__v2（必需）与 acw_tc（可选）。 */
export function mergeCookie(existing: string | undefined, acwScV2: string, acwTc: string): string {
  let r = mergeAcwScV2(existing, acwScV2)
  if (!acwTc || !/^[0-9A-Za-z._-]+$/.test(acwTc)) return r
  const parts = r.split(';').map((p) => p.trim()).filter(Boolean)
  const out: string[] = []
  let replaced = false
  for (const part of parts) {
    if (part.startsWith('acw_tc=')) {
      if (!replaced) {
        out.push(`acw_tc=${acwTc}`)
        replaced = true
      }
    } else {
      out.push(part)
    }
  }
  if (!replaced) out.push(`acw_tc=${acwTc}`)
  r = out.join('; ')
  return r
}

/** 合并任意 Set-Cookie 列表进既有 Cookie 串（同键覆盖）。 */
export function mergeSetCookies(existing: string | undefined, setCookies: string[]): string {
  const jar = new Map<string, string>()
  for (const part of (existing ?? '').split(';')) {
    const t = part.trim()
    const eq = t.indexOf('=')
    if (eq > 0) jar.set(t.slice(0, eq), t.slice(eq + 1))
  }
  for (const sc of setCookies) {
    const first = sc.split(';')[0]
    const eq = first.indexOf('=')
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim())
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}
