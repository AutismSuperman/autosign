import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProxyProbeResult, ProxySettings } from '../../shared/types'
import { send } from './httpClient'

const execFileAsync = promisify(execFile)

/**
 * 代理解析。
 *
 * 桌面端与手机端最大的差异：目标站点在部分网络环境下直连不可达（连接被重置），
 * 因此代理是**必需能力**而非可选优化。三种来源：
 *   1. manual：用户在设置页显式填写
 *   2. system：读取系统代理（Windows 注册表 / macOS scutil / Linux 环境变量）
 *   3. env：HTTP(S)_PROXY 环境变量
 *
 * 解析只做发现，实际拨号由 httpClient 负责。
 */

function normalize(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^(https?|socks5h?):\/\//i.test(s)) return s
  return `http://${s}`
}

async function fromEnv(): Promise<string> {
  return normalize(
    process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy ??
      process.env.ALL_PROXY ??
      process.env.all_proxy ??
      ''
  )
}

async function fromWindowsRegistry(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { windowsHide: true, timeout: 5000 }
    )
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)
    if (!enabled) return ''
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout)
    if (!m) return ''
    // 可能是 "http=127.0.0.1:7890;https=127.0.0.1:7890" 形式，优先取 https
    const raw = m[1]
    if (raw.includes('=')) {
      const map = new Map<string, string>()
      for (const part of raw.split(';')) {
        const [k, v] = part.split('=')
        if (k && v) map.set(k.toLowerCase(), v)
      }
      return normalize(map.get('https') ?? map.get('http') ?? '')
    }
    return normalize(raw)
  } catch {
    return ''
  }
}

async function fromMacScutil(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('scutil', ['--proxy'], {
      timeout: 5000
    })
    const httpsOn = /HTTPSEnable\s*:\s*1/.test(stdout)
    const httpsHost = /HTTPSProxy\s*:\s*(\S+)/.exec(stdout)?.[1]
    const httpsPort = /HTTPSPort\s*:\s*(\d+)/.exec(stdout)?.[1]
    if (httpsOn && httpsHost && httpsPort) return normalize(`${httpsHost}:${httpsPort}`)
    const socksOn = /SOCKSEnable\s*:\s*1/.test(stdout)
    const socksHost = /SOCKSProxy\s*:\s*(\S+)/.exec(stdout)?.[1]
    const socksPort = /SOCKSPort\s*:\s*(\d+)/.exec(stdout)?.[1]
    if (socksOn && socksHost && socksPort) return normalize(`socks5://${socksHost}:${socksPort}`)
    return ''
  } catch {
    return ''
  }
}

/** 读取系统代理；无则返回空串。 */
export async function systemProxy(): Promise<{ url: string; source: string }> {
  const env = await fromEnv()
  if (env) return { url: env, source: 'env' }
  if (process.platform === 'win32') {
    const reg = await fromWindowsRegistry()
    if (reg) return { url: reg, source: 'registry' }
  } else if (process.platform === 'darwin') {
    const mac = await fromMacScutil()
    if (mac) return { url: mac, source: 'scutil' }
  }
  return { url: '', source: 'none' }
}

/** 按设置解析出最终代理地址。 */
export async function resolveProxy(settings: ProxySettings): Promise<{ url: string; source: string }> {
  if (settings.mode === 'direct') return { url: '', source: 'direct' }
  if (settings.mode === 'manual') {
    return { url: normalize(settings.url), source: settings.url ? 'manual' : 'none' }
  }
  return systemProxy()
}

/**
 * 探测代理是否可用：用与业务请求完全相同的一条拨号路径请求目标站点，
 * 避免出现「探测走一套、业务走另一套」的不一致。
 */
export async function probeProxy(settings: ProxySettings, testUrl: string): Promise<ProxyProbeResult> {
  const { url, source } = await resolveProxy(settings)
  try {
    const res = await send(testUrl, { method: 'GET', proxy: url, timeoutMs: 15_000 })
    const reachable = res.status > 0 && res.status < 500
    return {
      ok: reachable,
      proxy: url || undefined,
      source,
      error: reachable ? undefined : `HTTP ${res.status}`
    }
  } catch (e) {
    return {
      ok: false,
      proxy: url || undefined,
      source,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
