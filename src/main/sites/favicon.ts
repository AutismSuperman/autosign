import { app } from 'electron'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { Agent } from 'node:http'

/**
 * 站点图标（logo）抓取与缓存。
 *
 * 目标：侧栏、站点卡片、添加站点对话框都显示站点自己的图标，
 * 而不是「首字母方块」。
 *
 * 几个约束：
 *   1. 图标是二进制，不能走按字符串解析的 send()；这里单独用 http/https
 *   2. 站点多有 WAF，但图标通常由 CDN 直接返回；抓不到就回退字母头像，
 *      不做重试、不求解质询 —— 图标不值得为它折腾会话
 *   3. 渲染层 CSP 是 img-src 'self' data:，因此以 data URL 交给界面；
 *      同时落盘缓存，避免每次启动都重新抓
 *   4. 站点把 logo 放在 /logo.png（New API 约定）或 HTML 的
 *      <link rel="icon">，两种都试
 */

/** 图标缓存目录。 */
function cacheDir(): string {
  return join(app.getPath('userData'), 'site-icons')
}

/** 用 URL + 尺寸做缓存键，换站点地址会重新抓。 */
function cacheKey(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16)
}

function buildAgent(proxy: string): Agent | undefined {
  if (!proxy) return undefined
  if (/^socks/i.test(proxy)) return new SocksProxyAgent(proxy) as unknown as Agent
  return new HttpsProxyAgent(proxy) as unknown as Agent
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** 抓二进制资源，跟随重定向，限制大小。 */
function fetchBinary(
  url: string,
  proxy: string,
  redirects = 3
): Promise<{ status: number; contentType: string; data: Buffer } | { error: string }> {
  return new Promise((resolve) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      resolve({ error: '地址无效' })
      return
    }
    const doRequest = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = doRequest(
      u,
      {
        headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
        timeout: 12_000,
        agent: buildAgent(proxy)
      },
      (res) => {
        const status = res.statusCode ?? 0
        // 重定向：跟随，但要防止跳转到非 http(s)
        if (status >= 300 && status < 400 && res.headers.location) {
          try {
            const next = new URL(res.headers.location, u).toString()
            res.resume()
            if (redirects <= 0) {
              resolve({ error: '重定向过多' })
              return
            }
            void fetchBinary(next, proxy, redirects - 1).then(resolve)
            return
          } catch {
            res.resume()
            resolve({ error: '重定向地址无效' })
            return
          }
        }
        if (status !== 200) {
          res.resume()
          resolve({ error: `HTTP ${status}` })
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (d: Buffer) => {
          size += d.length
          // 图标不该超过 512KB，超了直接放弃
          if (size > 512 * 1024) {
            req.destroy()
            resolve({ error: '图标过大' })
            return
          }
          chunks.push(d)
        })
        res.on('end', () =>
          resolve({
            status,
            contentType: String(res.headers['content-type'] ?? ''),
            data: Buffer.concat(chunks)
          })
        )
        res.on('error', (e) => resolve({ error: e.message }))
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ error: '超时' })
    })
    req.on('error', (e) => resolve({ error: e.message }))
    req.end()
  })
}

/** 抓 HTML 里的 <link rel="icon"> 地址。 */
async function iconHrefFromHtml(baseUrl: string, proxy: string): Promise<string | undefined> {
  const r = await fetchBinary(baseUrl, proxy)
  if ('error' in r) return undefined
  const html = r.data.toString('utf8')
  const patterns = [
    /<link[^>]+rel=["']?[^"'>]*icon[^"'>]*["']?[^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']?[^"'>]*icon/i
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]) {
      try {
        return new URL(m[1], baseUrl).toString()
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** 把二进制转成 data URL（渲染层受 CSP 限制，只能这样显示）。 */
function toDataUrl(contentType: string, data: Buffer): string {
  const type = contentType.split(';')[0].trim() || 'image/png'
  // ico 浏览器都能显示；统一按原始 mime 交给 <img>
  return `data:${type};base64,${data.toString('base64')}`
}

/** 内容看起来像图片才接受（防止把 404 页存成图标）。 */
function looksLikeImage(contentType: string, data: Buffer): boolean {
  if (/^image\//i.test(contentType)) return true
  if (data.length < 16) return false
  const sig = data.subarray(0, 4).toString('hex')
  // PNG / ICO / GIF / JPEG / WEBP / SVG
  return (
    sig === '89504e47' ||
    sig === '00000100' ||
    sig === '47494638' ||
    sig.startsWith('ffd8ff') ||
    data.subarray(0, 4).toString('ascii') === 'RIFF' ||
    data.subarray(0, 5).toString('utf8').startsWith('<svg') ||
    data.subarray(0, 5).toString('utf8').startsWith('<?xml')
  )
}

/**
 * 获取站点图标。
 *
 * 顺序：磁盘缓存 → /logo.png → HTML 里的 icon → /favicon.ico
 * 全失败返回 undefined，界面回退到字母头像。
 */
export async function getSiteIcon(baseUrl: string, proxy: string): Promise<string | undefined> {
  const base = baseUrl.replace(/\/+$/, '')
  const key = cacheKey(base)
  const file = join(cacheDir(), `${key}.txt`)

  // 1) 磁盘缓存
  try {
    const cached = await readFile(file, 'utf8')
    if (cached.startsWith('data:image/')) return cached
  } catch {
    // 未缓存
  }

  // 2) 依次尝试候选地址
  const candidates: string[] = [`${base}/logo.png`]
  const fromHtml = await iconHrefFromHtml(base, proxy)
  if (fromHtml) candidates.push(fromHtml)
  candidates.push(`${base}/favicon.ico`)

  for (const url of candidates) {
    const r = await fetchBinary(url, proxy)
    if ('error' in r || r.data.length === 0) continue
    if (!looksLikeImage(r.contentType, r.data)) continue
    const dataUrl = toDataUrl(r.contentType, r.data)
    try {
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(file, dataUrl, 'utf8')
    } catch {
      // 写缓存失败不影响本次显示
    }
    return dataUrl
  }
  return undefined
}
