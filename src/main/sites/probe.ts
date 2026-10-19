import type { SiteKind, SiteProbeResult } from '../../shared/types'
import { send, parseJson } from '../net/httpClient'
import { checkinActionPath, hostOf, inferKind, rewardLogPath } from './profile'

/**
 * 站点能力探测：读 /api/status，判断站点形态、签到端点、Turnstile 与 OAuth 配置。
 *
 * 这是「加站点」与「诊断」的核心：不靠用户猜，也不靠硬编码域名，
 * 全部由站点自己公开的 /api/status 与端点探测得出。
 */

interface StatusPayload {
  data?: {
    system_name?: string
    version?: string
    turnstile_check?: boolean
    turnstile_site_key?: string
    checkin_enabled?: boolean
    github_oauth?: boolean
    linuxdo_oauth?: boolean
    github_client_id?: string
    [k: string]: unknown
  }
}

export async function probeSite(baseUrl: string, proxy?: string): Promise<SiteProbeResult> {
  const base = baseUrl.replace(/\/+$/, '')
  const url = `${base}/api/status`
  try {
    const res = await send(url, { proxy, timeoutMs: 20_000 })
    const json = parseJson<StatusPayload>(res.body)
    const data = json?.data ?? {}

    // 端点存在性用 POST 的 404/非 404 判定（GET 的 401 是通配鉴权，没有区分度）。
    const selfHttp = res.status
    let checkinHttp = 0
    try {
      const probe = await send(`${base}/api/user/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        proxy,
        timeoutMs: 12_000
      })
      checkinHttp = probe.status
    } catch {
      checkinHttp = 0
    }

    const kind: SiteKind = inferKind(selfHttp, checkinHttp)
    const turnstile = Boolean(data.turnstile_check)

    return {
      ok: res.status === 200 && !!json,
      baseUrl: base,
      http: res.status,
      systemName: typeof data.system_name === 'string' ? data.system_name : undefined,
      kind,
      mode: turnstile ? 'BUTTON' : hostOf(base).includes('agentrouter') ? 'RELOGIN' : 'BUTTON',
      turnstile,
      turnstileSiteKey: typeof data.turnstile_site_key === 'string' ? data.turnstile_site_key : undefined,
      checkinEnabled: data.checkin_enabled === true,
      githubOAuth: data.github_oauth === true,
      linuxdoOAuth: data.linuxdo_oauth === true,
      githubClientId: typeof data.github_client_id === 'string' ? data.github_client_id : undefined,
      wafSolved: res.wafSolved
    }
  } catch (e) {
    return {
      ok: false,
      baseUrl: base,
      http: 0,
      kind: 'NEWAPI',
      mode: 'BUTTON',
      turnstile: false,
      wafSolved: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/** 供诊断页展示：该站点会用到的端点清单。 */
export function endpointsFor(baseUrl: string, kind: SiteKind): Array<{ label: string; path: string }> {
  const site = { baseUrl, kind }
  const out: Array<{ label: string; path: string }> = [
    { label: '站点状态', path: '/api/status' },
    { label: '会话 / 额度', path: '/api/user/self' }
  ]
  const checkin = checkinActionPath(site)
  if (checkin) out.push({ label: '签到动作', path: checkin })
  const status = kind === 'WELFARE' ? '/api/checkin/status' : '/api/user/checkin'
  if (status) out.push({ label: '签到状态', path: status })
  const reward = rewardLogPath(kind)
  if (reward) out.push({ label: '奖励流水', path: reward })
  return out
}
