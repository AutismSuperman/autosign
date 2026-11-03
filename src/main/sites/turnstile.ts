import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { accountPartition } from './partition'
import { safeCurrentUrl, withHiddenWindow } from './hiddenWindow'
import type { HiddenWindowAbortReason } from './hiddenWindow'
import { withPartitionLock } from './partitionLock'

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
 * 页面脚本的单轮等待上限。
 *
 * 挂件在 35 秒内既不出 token 也不报错，就说明这次无感验证过不去。
 * 实测正常站点 1.7~13 秒出 token，35 秒留了足够余量。
 */
const SCRIPT_WAIT_MS = 35_000

/** turn-limit 命中后，脚本内冷却多久再起新挂件。 */
const TURN_LIMIT_COOLDOWN_MS = 6_000

/** 外层重试前再等多久。 */
const RETRY_GAP_MS = 1_000

/**
 * 同一个站点两次取令牌之间的最小间隔。
 *
 * 真机实测（本机 2026-11，kktoken.cc）：同一分区连续串行取 3 次，
 * 第 1 次被判「需要人工交互」、后两次成功 —— 串行并不能避免风控，
 * 问题在于「短时间内同一 sitekey 反复起挂件」。Cloudflare 会把它当成
 * 异常流量，先降级成强制交互，再升级成 300030。
 *
 * 分区锁解决了「同时开两个」，这里补上「连续开太快」。
 * 按站点维度节流而不是按分区：同一站点的多个账号共用一个 sitekey，
 * 风控也按 sitekey 计，所以要跨账号生效。
 */
const SITE_MIN_GAP_MS = 8_000

/**
 * 每个站点上一次取令牌的结束时间。
 *
 * 用模块级 Map 而不是实例字段：`acquireTurnstileToken` 是无状态导出函数，
 * 批量签到会反复调用它，节流状态必须跨调用保留。
 */
const lastAttemptAt = new Map<string, number>()

/** 等到距上次对同一站点取令牌已过 `SITE_MIN_GAP_MS`。 */
async function waitForSiteGap(host: string): Promise<void> {
  const last = lastAttemptAt.get(host)
  if (last === undefined) return
  const wait = SITE_MIN_GAP_MS - (Date.now() - last)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

/** 记下这次尝试结束的时间，供下一次节流判断。 */
function markSiteAttempt(host: string): void {
  lastAttemptAt.set(host, Date.now())
}

/**
 * 整轮硬超时的下限。
 *
 * 原实现固定 70 秒，而内层最坏路径是
 * `加载 + 35s + 6s 冷却 + 1s + 35s ≈ 77s` —— 外层会先到点，
 * 返回泛泛的「获取人机验证令牌超时」，把 turn-limit / wait-timeout
 * 这类具体诊断盖掉。这里按内层真实预算推导，再留 20 秒给页面加载。
 */
const DEADLINE_MS =
  SCRIPT_WAIT_MS * 2 + TURN_LIMIT_COOLDOWN_MS + RETRY_GAP_MS + 20_000

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
  const WAIT_MS = ${SCRIPT_WAIT_MS};
  const COOLDOWN_MS = ${TURN_LIMIT_COOLDOWN_MS};
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

  window.__autosign_interactive = false;
  try {
    window.turnstile.render('#__autosign_ts', {
      sitekey: KEY,
      appearance: 'interaction-only',
      callback: (t) => { window.__autosign_token = t; },
      'error-callback': (c) => { window.__autosign_err = String(c); return true; },
      'timeout-callback': () => { window.__autosign_err = 'timeout'; },
      /* appearance=interaction-only 时，Cloudflare 判定本次必须人工点选才会显示勾选框。
       * 隐藏窗口没人能点，只能空等到超时 —— 记下来，让调用方立刻放弃并如实说明，
       * 而不是把「需要人工验证」报成一个含糊的「超时」。 */
      'before-interactive-callback': () => { window.__autosign_interactive = true; },
      'unsupported-callback': () => { window.__autosign_err = 'unsupported'; }
    });
  } catch (e) {
    return { status: 'render-failed', error: String(e) };
  }

  /* 轮询：出 token / 报错 / 需要人工交互，任一命中就结束，不再干等到超时。
   * 隐藏窗口里人工交互不可能完成，越早返回越能给出准确原因。 */
  const got = await waitFor(
    () => !!window.__autosign_token || !!window.__autosign_err || window.__autosign_interactive,
    WAIT_MS
  );
  if (window.__autosign_token) return { status: 'ok', token: window.__autosign_token };
  if (window.__autosign_interactive) {
    return { status: 'interactive-required', error: '本次验证需要人工点击' };
  }
  if (window.__autosign_err) {
    /* turn-limit（300030）是客户端触发频率上限：同 sitekey 短时间内起挂件太多次。
     * Cloudflare 官方建议等待几秒后重试；它与网络 / 会话类错误不同，重试通常能过。
     * 每次重试都用全新挂件，重置上一个挂件留下的失败状态。 */
    if (/turn-limit|300030|rate.?limit/i.test(window.__autosign_err)) {
      if (window.__autosign_retry === undefined) window.__autosign_retry = 0;
      if (window.__autosign_retry < 1) {
        window.__autosign_retry++;
        window.__autosign_err = null;
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));
        const w = document.getElementById('__autosign_ts');
        if (w) w.remove();
        return { status: 'retry' };
      }
    }
    return { status: 'error', error: window.__autosign_err };
  }
  return { status: got ? 'unknown' : 'wait-timeout' };
})()`
}

/**
 * 在隐藏窗口中取得 Turnstile 令牌。
 *
 * @param partitionKey 稳定的分区标识（建议 `站点ID|账号ID`）
 * @param proxy 代理地址；空串表示直连。隐藏窗口必须走与业务请求相同的出口，
 *              否则页面加载不到，验证也就无从谈起。
 * @param timeoutMs 整轮硬超时。默认按内层真实预算推导（见 `DEADLINE_MS`），
 *                  调用方一般不必传；传了也不会低于该下限，避免又把诊断盖掉。
 */
export async function acquireTurnstileToken(
  baseUrl: string,
  sitekey: string,
  cookie: string | undefined,
  partitionKey: string,
  proxy = '',
  timeoutMs = DEADLINE_MS
): Promise<TurnstileResult> {
  if (!sitekey) return { ok: false, error: '站点未提供 Turnstile sitekey' }

  // partitionKey 形如 "<siteId>|<accountId>"；与授权、签到共用同一个分区
  const [siteId, accountId] = partitionKey.split('|')
  const partition = accountPartition(siteId ?? partitionKey, accountId ?? 'probe')
  const host = hostOf(baseUrl)

  // 节流放在锁外面：等待本身不需要占用分区，
  // 否则同分区后来的任务会被白白多挡一个完整间隔。
  await waitForSiteGap(host)

  // 同一分区同时起两个挂件会触发 Cloudflare 300030（客户端频率上限），
  // 而重试逻辑又会开更多窗口 —— 在这里排队，让第二个调用等第一个结束。
  try {
    return await withPartitionLock(partition, () =>
      acquireInWindow(baseUrl, sitekey, cookie, partition, proxy, Math.max(timeoutMs, DEADLINE_MS))
    )
  } finally {
    // 无论成败都记一笔：失败同样消耗了站点的风控额度
    markSiteAttempt(host)
  }
}

/** 取站点主机名，用作节流键。URL 解析失败时退回原串。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return baseUrl.trim().toLowerCase()
  }
}

async function acquireInWindow(
  baseUrl: string,
  sitekey: string,
  cookie: string | undefined,
  partition: string,
  proxy: string,
  timeoutMs: number
): Promise<TurnstileResult> {
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

  /** 任务体在失败时统一带上「当前分区 Cookie」，供随后的原生 POST 复用。 */
  const fail = async (error: string): Promise<TurnstileResult> => ({
    ok: false,
    cookie: await readCookies(ses, baseUrl),
    error
  })

  return withHiddenWindow<TurnstileResult>(
    {
      label: 'turnstile',
      create: () =>
        new BrowserWindow({
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
        }),
      timeoutMs,
      /* 外层到点的兜底文案。
       * 正常情况下内层会先返回具体原因（wait-timeout / interactive-required /
       * turn-limit），走到这里说明连内层都没能给出结论 —— 那才是真正的「整轮超时」。
       * 带上秒数，让用户知道该等多久再试。 */
      fallback: (reason: HiddenWindowAbortReason, detail?: string) => {
        if (reason === 'closed') {
          return { ok: false, error: '人机验证窗口被关闭，验证未完成' }
        }
        if (reason === 'error') {
          return { ok: false, error: `人机验证执行失败：${detail ?? '未知原因'}` }
        }
        return {
          ok: false,
          error: `人机验证整轮超时（${Math.round(timeoutMs / 1000)} 秒内未完成），请更换代理节点后重试`
        }
      }
    },
    async ({ win, aborted }) => {
      try {
        await win.loadURL(baseUrl)
      } catch (e) {
        // 加载失败要如实上报（代理挂掉、DNS 不通），不能被兜底成「超时」
        return fail(`页面加载失败：${e instanceof Error ? e.message : String(e)}`)
      }
      if (aborted()) return fail('人机验证已中止')

      // 站点把未登录用户重定向到登录页时，说明会话已失效 —— 如实报告，不空转等验证
      const current = safeCurrentUrl(win)
      if (/\/sign-?in|\/login|\/auth\//i.test(current) && !/\/console|\/dashboard/i.test(current)) {
        return fail('会话已失效，需要重新授权')
      }

      // turn-limit 重试一轮：脚本内已冷却，这里再留一点间隔后起全新挂件
      let raw: unknown
      try {
        raw = await win.webContents.executeJavaScript(tokenScript(sitekey), true)
        if (aborted()) return fail('人机验证已中止')
        const first = raw as { status?: string } | null
        if (first?.status === 'retry') {
          await new Promise((r) => setTimeout(r, RETRY_GAP_MS))
          if (aborted()) return fail('人机验证已中止')
          raw = await win.webContents.executeJavaScript(tokenScript(sitekey), true)
        }
      } catch (e) {
        // 窗口在脚本执行期间被销毁也会走这里，如实报出而不是假装超时
        return fail(`验证脚本执行失败：${e instanceof Error ? e.message : String(e)}`)
      }

      const result = raw as { status?: string; token?: string; error?: string } | null
      const cookieNow = await readCookies(ses, baseUrl)

      if (result?.status === 'ok' && result.token) {
        return { ok: true, token: result.token, cookie: cookieNow }
      }

      /* 把状态翻译成用户能照做的说法。隐藏窗口里能做的只有「自动过」和「明确放弃」，
       * 需要人点的时候绝不假装是网络问题 —— 那会让人反复重试同一个必失败的动作。 */
      if (result?.status === 'interactive-required') {
        return {
          ok: false,
          cookie: cookieNow,
          error:
            '本次人机验证要求人工点击，自动签到无法完成。请到站点网页端手动签到一次；若长期出现，请更换代理节点'
        }
      }
      if (result?.status === 'wait-timeout') {
        return {
          ok: false,
          cookie: cookieNow,
          error: `等待人机验证超时（站点 ${Math.round(SCRIPT_WAIT_MS / 1000)} 秒内没有放行）。可能是当前代理节点被风控、或站点人机验证变严，请更换节点后重试`
        }
      }
      if (result?.status === 'script-failed') {
        return {
          ok: false,
          cookie: cookieNow,
          error: '人机验证组件加载失败（Cloudflare 脚本没加载出来），请检查代理是否拦截了 challenges.cloudflare.com'
        }
      }

      /* Cloudflare 用数字码报因由，直接甩给用户等于没说。
       * 常见码（官方文档）：
       *   600010 / 110200 — 校验失败或站点配置的域名不匹配
       *   300030          — 客户端触发频率超限（重试已在脚本内处理过）
       *   110420 / 110430 — 浏览器环境不受支持
       * 其余原样保留，至少能拿去搜。 */
      const codeText = result?.error ?? ''
      const codeOf = /(\d{5,6})/.exec(codeText)?.[1]
      const hint = ((): string | undefined => {
        if (!codeOf) return undefined
        if (codeOf === '600010' || codeOf === '110200')
          return '站点的人机验证校验失败（多为回调地址/域名配置问题），自动验证无法通过'
        if (codeOf === '300030') return '人机验证触发频率过高，请稍等几分钟再试'
        if (codeOf === '110420' || codeOf === '110430')
          return '当前浏览器环境不被 Cloudflare 支持，请更新应用或更换网络环境'
        return undefined
      })()
      if (hint) {
        return { ok: false, cookie: cookieNow, error: `${hint}（错误码 ${codeOf}）` }
      }

      const detail = result?.error ? `：${result.error}` : ''
      return {
        ok: false,
        cookie: cookieNow,
        error: `人机验证未通过（${result?.status ?? 'unknown'}）${detail}`
      }
    }
  )
}
