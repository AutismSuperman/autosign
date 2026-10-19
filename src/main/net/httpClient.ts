import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { Agent } from 'node:http'
import { isChallenge, arg1, solve, pickCookieValue, mergeCookie, mergeSetCookies } from './waf'

/**
 * HTTP 客户端。
 *
 * 不直接使用全局 fetch：目标站点普遍启用阿里云 ESA 质询（acw_sc__v2），
 * 需要「拿到质询 → 本地求解 → 带 Cookie 重发」这套握手。Node 的 fetch（undici）
 * 不暴露底层 socket，而 http/https 模块允许我们完全控制请求头与代理 agent。
 *
 * WAF 自愈策略与上游一致：
 *   1. 首次请求若返回 200 但正文是质询页，求解后带 acw_sc__v2 + acw_tc 重发一次
 *   2. 质询 Cookie 写回站点会话，后续请求直接带上
 */

export interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  setCookies: string[]
  body: string
  /** 本次请求是否发生过 WAF 求解。 */
  wafSolved: boolean
  url: string
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** 代理地址；空串表示直连。 */
  proxy?: string
  timeoutMs?: number
  /** 站点已有会话 Cookie，用于携带与回写质询结果。 */
  cookie?: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function buildAgent(proxy: string): Agent | undefined {
  if (!proxy) return undefined
  if (/^socks/i.test(proxy)) return new SocksProxyAgent(proxy) as unknown as Agent
  return new HttpsProxyAgent(proxy) as unknown as Agent
}

function rawRequest(
  url: string,
  opts: RequestOptions,
  agent: Agent | undefined,
  cookie: string
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; setCookies: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const doRequest = isHttps ? httpsRequest : httpRequest
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...opts.headers
    }
    if (cookie) headers.Cookie = cookie
    if (opts.body) {
      headers['Content-Length'] = String(Buffer.byteLength(opts.body))
    }
    const req = doRequest(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? 'GET',
        headers,
        agent: agent ?? undefined,
        timeout: opts.timeoutMs ?? 20_000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const setCookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []
          const hdrs = { ...res.headers } as Record<string, string | string[] | undefined>
          delete hdrs['set-cookie']
          resolve({
            status: res.statusCode ?? 0,
            headers: hdrs,
            setCookies,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('请求超时'))
    })
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/**
 * 发起一次请求，并自动处理多轮 WAF 质询（至多 2 轮）。
 * 返回的 setCookies 已包含求解得到的质询 Cookie，调用方应合并进站点会话。
 */
export async function send(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const agent = buildAgent(opts.proxy ?? '')
  let cookie = opts.cookie ?? ''
  let wafSolved = false

  for (let round = 0; round <= 2; round++) {
    const res = await rawRequest(url, opts, agent, cookie)
    // 质询页通常返回 200 且正文含 arg1 赋值。HTTP 错误码也可能夹带质询。
    if (isChallenge(res.body)) {
      const a1 = arg1(res.body)
      const v2 = solve(a1)
      if (!v2) {
        return { ...res, url, wafSolved }
      }
      const acwTc = pickCookieValue(res.setCookies.join('; '), 'acw_tc')
      // 把质询 Cookie 合进本次 Cookie，并作为额外 Set-Cookie 交给调用方落库
      cookie = mergeCookie(cookie, v2, acwTc)
      wafSolved = true
      const synth = [`acw_sc__v2=${v2}`]
      if (acwTc) synth.push(`acw_tc=${acwTc}`)
      res.setCookies.push(...synth)
      if (round === 2) {
        return { ...res, url, wafSolved, setCookies: res.setCookies }
      }
      continue
    }
    // 正常响应：把质询 Cookie（若有）与站点 Cookie 合并后返回
    const merged = mergeSetCookies(cookie, res.setCookies)
    void merged
    return { ...res, url, wafSolved }
  }
  // 理论不可达
  throw new Error('WAF 质询处理轮次超限')
}

/** 组装请求头：New API 系需要 Authorization 与 New-Api-User。 */
export function authHeaders(token: string | undefined, siteUserId: string | undefined): Record<string, string> {
  const h: Record<string, string> = {}
  if (token) h.Authorization = `Bearer ${token}`
  if (siteUserId) h['New-Api-User'] = siteUserId
  return h
}

/**
 * 判断响应是否被 WAF 拦截（归一化后的 503 语义）。
 *
 * 除旧版 arg1 质询与 Cloudflare 挑战页外，还要识别阿里云 WAF 的新版
 * 反爬页面：它以 HTTP 200 + text/html 返回，带 aliyun_waf_aa/bb 指纹
 * 与一段混淆过的 webpack 脚本。这种响应若按普通正文解析，会得到
 * 「响应结构无法识别」，把「代理节点被风控」误报成「站点改了协议」。
 */
export function wafBlocked(body: string): boolean {
  if (!body) return false
  if (isChallenge(body)) return true
  if (/aliyun_waf_[a-z]{2}/i.test(body)) return true
  return /<title>\s*(?:Just a moment|Attention Required|请稍候|安全验证|访问验证)/i.test(body)
}

/** 安全地解析 JSON，失败返回 null。 */
export function parseJson<T = unknown>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}
