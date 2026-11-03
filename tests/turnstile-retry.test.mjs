/**
 * Turnstile 取令牌行为测试。
 *
 * 起因（用户现场）：kktoken 签到报「人机验证未通过：超时」，日志里却只有
 * 一句笼统的失败，看不出隐藏窗口里到底发生了什么。
 *
 * 相关修复：
 *   1. tokenScript 内嵌脚本要能原样解析（模板拼接一旦出错，注入就是语法错误）
 *   2. turn-limit（Cloudflare 300030，客户端触发频率上限）不再是终态：
 *      等待冷却后用全新挂件重试一轮
 *   3. 失败状态（wait-timeout / turn-limit / script-failed）原样透出，
 *      不折叠成「人机验证未通过」一句
 *
 * 取令牌依赖真实 Chromium 渲染上下文，无法纯逻辑测试；这里锁住脚本内容
 * 与重试闸门的行为约定。运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/turnstile.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/turnstile.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const mod = require('../.tmp/turnstile.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// tokenScript 未导出（内嵌在模块里），从源码文本提取后再做行为断言。
// 直接 require 模块只能验证它在 Node 下加载不炸（electron 是 external）。
const { readFileSync } = await import('node:fs')
const src = readFileSync('src/main/sites/turnstile.ts', 'utf8')

// ---- 模块可加载 ----
check('模块在 Node 下可加载（不触碰 Electron API）', typeof mod.acquireTurnstileToken === 'function')

// ---- 注入脚本：语法必须可解析 ----
// 提取 tokenScript 模板字符串的脚本主体：从 "(async () => {" 起，
// 到 "})()"" 之前（那是模板的闭合调用，不属于正文）。换行是 CRLF，不做行级假设。
const scriptStart = src.indexOf('return `(async () => {')
const scriptEnd = src.indexOf('})()`', scriptStart)
const scriptMatch =
  scriptStart >= 0 && scriptEnd > scriptStart
    ? { body: src.slice(scriptStart + 'return `(async () => {'.length, scriptEnd) }
    : null
check(
  'tokenScript 模板可定位',
  !!scriptMatch,
  scriptMatch ? '' : '未在源码中找到注入脚本模板'
)

if (scriptMatch) {
  const KEY = '0x4AAAAAAA-test-sitekey'
  // 还原模板：脚本里所有 ${...} 都是编译期插值，这里换成等价值。
  // 新增常量时记得同步补一条 —— 否则脚本还原后带字面量 ${} 会解析失败。
  const body = scriptMatch.body
    .replace(/\$\{JSON\.stringify\(sitekey\)\}/g, JSON.stringify(KEY))
    .replace(/\$\{SCRIPT_WAIT_MS\}/g, '35000')
    .replace(/\$\{TURN_LIMIT_COOLDOWN_MS\}/g, '6000')
    .replace(/\r\n/g, '\n')
    .trim()
  // 正文最后自带 async 函数体的 "}"，这里只补闭合与调用
  const full = `(async () => {${body}})()`

  // 0) 还原后不该残留未替换的插值（否则语法检查会被它误导）
  check('脚本模板占位符已全部替换', !/\$\{/.test(body), (body.match(/\$\{[^}]*\}/g) || []).join(','))

  // 1) 语法检查：new Function 只构造不调用（脚本要跑在浏览器上下文里）
  let syntaxOk = true
  let syntaxErr = ''
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return ${full}`)
  } catch (e) {
    syntaxOk = false
    syntaxErr = String(e.message ?? e)
  }
  check('注入脚本语法可解析', syntaxOk, syntaxErr)

  // 2) 关键行为约定都在脚本里
  check(
    'turn-limit 会被识别（300030 / rate limit）',
    /turn-limit|300030|rate\?\.?limit/i.test(body)
  )
  check(
    'turn-limit 有重试闸门（__autosign_retry）',
    /__autosign_retry/.test(body)
  )
  check(
    '重试前冷却等待（由常量控制，脚本内引用 COOLDOWN_MS）',
    /COOLDOWN_MS/.test(body) && /setTimeout\(r,\s*COOLDOWN_MS\)/.test(body)
  )
  check(
    '重试用全新挂件（移除旧节点再渲染）',
    /__autosign_ts.*remove|remove\(\)/.test(body)
  )
  check(
    'retry 状态会让外层再执行一次脚本',
    /status === 'retry'/.test(src.slice(src.indexOf('async function acquireInWindow')))
  )
  check(
    '失败状态原样透出（status 不被折叠）',
    src.includes('error: `人机验证未通过（${result?.status ?? \'unknown\'}）${detail}`')
  )

  /* ---- 需要人工交互 vs 普通超时：必须能分开 ----
   * 现场（kktoken 3 个账号）：报「人机验证未通过（wait-timeout）」。
   * appearance=interaction-only 下，Cloudflare 若判定本次必须人工点选，
   * 勾选框会显示在隐藏窗口里 —— 没人能点，脚本只能空等到 35 秒超时，
   * error-callback / timeout-callback 都不触发，于是落进 wait-timeout，
   * 用户看到的是一个含糊的「超时」，无从知道其实是「需要人手点一下」。
   * 修法：挂 before-interactive-callback，一旦要交互就立刻返回专门状态。 */
  check(
    '挂了 before-interactive-callback（能感知需要人工交互）',
    /before-interactive-callback/.test(body)
  )
  check(
    '需要人工交互时立刻结束等待（不等满 35 秒）',
    /window\.__autosign_interactive\s*\)\s*\{\s*return\s*\{\s*status:\s*'interactive-required'/.test(
      body.replace(/\r\n/g, '\n')
    )
  )
  check(
    '轮询条件包含交互标志',
    /__autosign_interactive,\s*\n?\s*35000|__autosign_token \|\| !!window\.__autosign_err \|\| window\.__autosign_interactive/.test(
      body.replace(/\r\n/g, '\n')
    )
  )
  check(
    '有 unsupported-callback（浏览器不支持时如实报）',
    /unsupported-callback/.test(body) && /unsupported/.test(body)
  )

  // 外层要把这三个状态翻译成用户能照做的说法，而不是只丢一个英文状态码
  const outer = src.slice(src.indexOf('async function acquireInWindow'))
  check(
    'interactive-required 有可操作的说明文案',
    /interactive-required'\)\s*\{[\s\S]{0,400}?人工点击/.test(outer)
  )
  check(
    'wait-timeout 提示换节点而不是只报超时',
    /wait-timeout'\)\s*\{[\s\S]{0,400}?更换节点/.test(outer)
  )
  check(
    'script-failed 提示检查代理拦截 challenges.cloudflare.com',
    /script-failed'\)\s*\{[\s\S]{0,400}?challenges\.cloudflare\.com/.test(outer)
  )
  /* Cloudflare 用数字码报因由（实测 always-fail 测试 key 返回 600010），
   * 直接甩数字等于没说。这几个码必须有中文可操作说明。 */
  check('错误码有翻译（600010 / 110200 → 站点配置问题）', /600010[\s\S]{0,200}?配置问题|配置问题[\s\S]{0,200}?600010/.test(outer))
  check('错误码有翻译（300030 → 频率过高）', /300030[\s\S]{0,120}?频率/.test(outer))
  check('错误码有翻译（110420 / 110430 → 环境不支持）', /110420[\s\S]{0,160}?环境/.test(outer))
  check('未知错误码仍原样保留（可拿去搜）', /错误码 \$\{codeOf\}|`\$\{hint\}（错误码 \$\{codeOf\}）`/.test(outer))
}

/* ---- 超时预算必须覆盖内层最坏路径（本次修复的核心缺陷）----
 *
 * 原实现：外层固定 70 秒，内层最坏 35 + 6 冷却 + 1 间隔 + 35 ≈ 77 秒。
 * 外层先到点，返回泛泛的「获取人机验证令牌超时」，把 turn-limit /
 * wait-timeout 这些具体诊断全部盖掉 —— 用户看到的症状正是「超时」，
 * 而真正的原因（频率限制）永远查不出来。
 *
 * 这里断言：外层预算按内层组成推导，且不写死。
 */
{
  const hasDerived =
    /const DEADLINE_MS\s*=\s*SCRIPT_WAIT_MS\s*\*\s*2\s*\+\s*TURN_LIMIT_COOLDOWN_MS\s*\+\s*RETRY_GAP_MS/.test(
      src
    )
  check('外层超时由内层预算推导（不再写死 70 秒）', hasDerived)

  // 真的把它算出来，验证 >= 内层最坏值
  const num = (name) => {
    const m = new RegExp(`const ${name}\\s*=\\s*([0-9_]+)`).exec(src)
    return m ? Number(m[1].replace(/_/g, '')) : NaN
  }
  const wait = num('SCRIPT_WAIT_MS')
  const cooldown = num('TURN_LIMIT_COOLDOWN_MS')
  const gap = num('RETRY_GAP_MS')
  const worstInner = wait * 2 + cooldown + gap
  check(
    '内层最坏路径已被常量表达（两轮等待 + 冷却 + 间隔）',
    Number.isFinite(wait) && Number.isFinite(cooldown) && Number.isFinite(gap),
    `wait=${wait} cooldown=${cooldown} gap=${gap}`
  )

  // DEADLINE_MS 的表达式里额外留了加载余量，必须严格大于内层最坏值。
  // 直接解析那一行里的数字，避免正则猜位置。
  const deadlineLine = (src.match(/const DEADLINE_MS\s*=\s*\r?\n?([\s\S]*?)\r?\n\r?\n/) || [])[1] || ''
  const literals = [...deadlineLine.matchAll(/([0-9][0-9_]*)/g)].map((m) =>
    Number(m[1].replace(/_/g, ''))
  )
  const extra = literals[literals.length - 1]
  check(
    '外层预算严格大于内层最坏值（留出页面加载余量）',
    Number.isFinite(extra) && extra > 0,
    `余量=${extra}ms, 内层最坏=${worstInner}ms, 表达式=${deadlineLine.replace(/\s+/g, ' ').trim()}`
  )

  // 调用方传更短的值也不能低于下限，否则诊断又会被盖掉
  check(
    '调用方传入的超时不会低于下限（Math.max 兜底）',
    /Math\.max\(timeoutMs,\s*DEADLINE_MS\)/.test(src)
  )

  // 外层超时的文案必须区别于内层的 wait-timeout，否则还是分不清
  check(
    '外层超时与内层 wait-timeout 文案不同（可区分卡在哪一层）',
    /人机验证整轮超时/.test(src) && /等待人机验证超时/.test(src)
  )
  check(
    '任务体在每次 await 后检查 aborted（不在已销毁窗口上继续操作）',
    (src.match(/if \(aborted\(\)\)/g) || []).length >= 2,
    `${(src.match(/if \(aborted\(\)\)/g) || []).length} 处`
  )
  check(
    '读 URL 走 safeCurrentUrl（不再裸调 getURL）',
    /safeCurrentUrl\(win\)/.test(src) && !/win\.webContents\.getURL\(\)/.test(src)
  )
  check('接入分区锁（同账号不并发开两个挂件）', /withPartitionLock/.test(src))

  /* ---- 站点级节流 ----
   * 真机实测：同一站点连续串行取 3 次，第 1 次被判「需要人工交互」。
   * 串行不够，还要限制「连续开太快」—— Cloudflare 按 sitekey 计风控，
   * 与分区无关，所以节流必须按站点维度、跨账号生效。
   */
  check('有站点级最小间隔常量', /SITE_MIN_GAP_MS\s*=\s*[0-9_]+/.test(src))
  check('节流状态跨调用保留（模块级 Map，不是函数内变量）', /^const lastAttemptAt = new Map/m.test(src))
  check('节流按站点维度（用 host 作键）', /lastAttemptAt\.(get|set)\(host/.test(src))
  check(
    '节流在分区锁之外等待（不白占分区）',
    src.indexOf('await waitForSiteGap(host)') < src.indexOf('withPartitionLock(partition')
  )
  check('失败也记一次（失败同样消耗风控额度）', /finally\s*\{[\s\S]{0,120}?markSiteAttempt\(host\)/.test(src))
}

// ---- acquireTurnstileToken 的空 sitekey 守卫 ----
// 不触网、不开窗口：空 sitekey 在任何 Electron 调用之前就返回
let guardErr = ''
try {
  await mod.acquireTurnstileToken('https://example.com', '', undefined, 'site|acc')
} catch (e) {
  guardErr = String(e.message ?? e)
}
check('空 sitekey 直接拒绝且不抛异常', guardErr === '', guardErr)

// ---- 人机验证失败 ≠ 会话失效 ----
// doCheckin 用 isSessionExpired(message) 决定要不要把账号标成 needsRelogin
// （界面据此显示「重新授权」）。人机验证类失败如果被误判成会话失效，
// 用户就会看到一堆「需要重新授权」，而账号其实好好的 —— 只是过不了验证。
// 这些文案必须保持「不是会话失效」。
await build({
  entryPoints: ['src/main/sites/reloginSession.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/turnstile-relogin.cjs',
  external: ['electron'],
  logLevel: 'error'
})
const { isSessionExpired } = require('../.tmp/turnstile-relogin.cjs')

const turnstileFailures = [
  '本次人机验证要求人工点击，自动签到无法完成。请到站点网页端手动签到一次；若长期出现，请更换代理节点',
  '等待人机验证超时（站点 35 秒内没有放行）。可能是当前代理节点被风控、或站点人机验证变严，请更换节点后重试',
  '站点的人机验证校验失败（多为回调地址/域名配置问题），自动验证无法通过（错误码 600010）',
  '人机验证组件加载失败（Cloudflare 脚本没加载出来），请检查代理是否拦截了 challenges.cloudflare.com',
  '人机验证未通过（error）：600010',
  '人机验证触发频率过高，请稍等几分钟再试（错误码 300030）'
]
for (const msg of turnstileFailures) {
  check(
    `人机验证失败不误判为会话失效：${msg.slice(0, 18)}…`,
    isSessionExpired(msg) === false
  )
}
// 反向对照：真正的会话失效仍必须被识别
check('真正的会话失效仍被识别', isSessionExpired('会话已失效，需要重新授权') === true)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
