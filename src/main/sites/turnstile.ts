import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { accountPartition } from './partition'

/**
 * Turnstile 令牌获取。
 *
 * 为什么必须借助浏览器：Cloudflare Turnstile 的令牌由挂件在真实渲染上下文中产出，
 * 校验绑定了页面来源与浏览器指纹，纯 HTTP 请求无法伪造。这里不破解、不代答，
 * 只是把站点自己的挂件放进一个不可见窗口里，让无感验证自然完成。
 *
 * 实测结论（本机，2026-10）：
 *   - Chrome 无头模式：挂件渲染但不出 token
 *   - Electron show:false 窗口：可以拿到真实 token
 *   - Electron offscreen 渲染：同样可以
 * 因此这里使用 show:false 的 BrowserWindow。
 *
 * 每个「站点 × 账号」使用稳定的持久化分区，WAF 放行 Cookie 得以复用，
 * 后续签到不必每次重新过质询。
 */

export interface TurnstileResult {
  ok: boolean
  token?: string
  /** 该分区当前适用于站点的 Cookie，供随后的原生 POST 使用。 */
  cookie?: string
  error?: string
}

/**
 * 不要覆盖 User-Agent。
 *
 * 实测（本机 2026-10）：给分区设自定义 UA（伪装成普通 Chrome）后，
 * seekai.cc 直接 ERR_FAILED 且 Turnstile 永远不出 token；保持 Electron 默认 UA
 * 反而能在十余秒内拿到真实令牌。原因是自定义 UA 与 navigator.userAgentData
 * 暴露的品牌/版本不一致，被 Turnstile 判定为环境异常。
 * 因此这里刻意不调用 setUserAgent。
 */

/** 把已保存的会话 Cookie 灌进分区，让页面以登录态加载。 */
async function seedCookies(ses: Session, baseUrl: string, cookie: string | undefined): Promise<void> {
  if (!cookie) return
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (!name) continue
    try {
      await ses.cookies.set({ url: baseUrl, name, value })
    } catch {
      // 个别名字可能不被接受，跳过即可，不影响其余 Cookie
    }
  }
}

/** 读取分区中当前适用于该站点的 Cookie。 */
async function readCookies(ses: Session, baseUrl: string): Promise<string> {
  try {
    const list = await ses.cookies.get({ url: baseUrl })
    return list.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

/** 注入到站点页面的取 token 脚本。 */
function tokenScript(sitekey: string): string {
  return `(async () => {
  const KEY = ${JSON.stringify(sitekey)};
  if (!KEY) return { status: 'no-sitekey' };
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return { status: 'bad-origin' };

  const waitFor = (fn, ms) => new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return res(true);
      if (Date.now() - t0 > ms) return res(false);
      setTimeout(tick, 200);
    };
    tick();
  });

  if (!window.turnstile) {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    document.head.appendChild(s);
    const loaded = await waitFor(() => !!window.turnstile, 20000);
    if (!loaded) return { status: 'script-failed' };
  }

  const box = document.createElement('div');
  box.id = '__autosign_ts';
  box.style.cssText = 'position:fixed;left:0;bottom:0;z-index:2147483647;';
  document.body.appendChild(box);

  try {
    window.turnstile.render('#__autosign_ts', {
      sitekey: KEY,
      appearance: 'interaction-only',
      callback: (t) => { window.__autosign_token = t; },
      'error-callback': (c) => { window.__autosign_err = String(c); return true; },
      'timeout-callback': () => { window.__autosign_err = 'timeout'; }
    });
  } catch (e) {
    return { status: 'render-failed', error: String(e) };
  }

  const got = await waitFor(() => !!window.__autosign_token || !!window.__autosign_err, 35000);
  if (window.__autosign_token) return { status: 'ok', token: window.__autosign_token };
  if (window.__autosign_err) return { status: 'error', error: window.__autosign_err };
  return { status: got ? 'unknown' : 'wait-timeout' };
})()`
}

/**
 * 在隐藏窗口中取得 Turnstile 令牌。
 *
 * @param partitionKey 稳定的分区标识（建议 `站点ID|账号ID`）
 * @param proxy 代理地址；空串表示直连。隐藏窗口必须走与业务请求相同的出口，
 *              否则页面加载不到，验证也就无从谈起。
 */
export async function acquireTurnstileToken(
  baseUrl: string,
  sitekey: string,
  cookie: string | undefined,
  partitionKey: string,
  proxy = '',
  timeoutMs = 70_000
): Promise<TurnstileResult> {
  if (!sitekey) return { ok: false, error: '站点未提供 Turnstile sitekey' }

  // partitionKey 形如 "<siteId>|<accountId>"；与授权、签到共用同一个分区
  const [siteId, accountId] = partitionKey.split('|')
  const partition = accountPartition(siteId ?? partitionKey, accountId ?? 'probe')
  const ses = session.fromPartition(partition)
  if (proxy) {
    try {
      await ses.setProxy({ proxyRules: proxy })
    } catch {
      // 代理设置失败时仍继续：直连也许能通，失败会在加载阶段如实报错
    }
  } else {
    try {
      await ses.setProxy({ mode: 'direct' })
    } catch {
      // 忽略：保持默认
    }
  }
  await seedCookies(ses, baseUrl, cookie)

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    skipTaskbar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })

  const cleanup = (): void => {
    try {
      win.destroy()
    } catch {
      // 窗口可能已被回收
    }
  }

  const deadline = new Promise<TurnstileResult>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: '获取人机验证令牌超时' }), timeoutMs)
  })

  const work = (async (): Promise<TurnstileResult> => {
    try {
      await win.loadURL(baseUrl)
    } catch (e) {
      return { ok: false, error: `页面加载失败：${e instanceof Error ? e.message : String(e)}` }
    }

    // 站点把未登录用户重定向到登录页时，说明会话已失效 —— 如实报告，不空转等验证
    const current = win.webContents.getURL()
    if (/\/sign-?in|\/login|\/auth\//i.test(current) && !/\/console|\/dashboard/i.test(current)) {
      return { ok: false, error: '会话已失效，需要重新授权' }
    }

    let raw: unknown
    try {
      raw = await win.webContents.executeJavaScript(tokenScript(sitekey), true)
    } catch (e) {
      return { ok: false, error: `验证脚本执行失败：${e instanceof Error ? e.message : String(e)}` }
    }

    const result = raw as { status?: string; token?: string; error?: string } | null
    const cookieNow = await readCookies(ses, baseUrl)

    if (result?.status === 'ok' && result.token) {
      return { ok: true, token: result.token, cookie: cookieNow }
    }
    const detail = result?.error ? `：${result.error}` : ''
    return {
      ok: false,
      cookie: cookieNow,
      error: `人机验证未通过（${result?.status ?? 'unknown'}）${detail}`
    }
  })()

  const result = await Promise.race([work, deadline])
  cleanup()
  return result
}
