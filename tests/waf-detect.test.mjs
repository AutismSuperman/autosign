/**
 * WAF 拦截识别与失败文案测试。
 *
 * 起因：阿里云 WAF 的反爬页以 HTTP 200 + text/html 返回，
 * 旧代码把它当成普通响应解析，得到「响应结构无法识别」，
 * 把「代理节点被风控」误报成「站点协议改了」。
 *
 * 覆盖：
 *   1. wafBlocked 能认出新版阿里云 WAF 指纹页
 *   2. 正常 JSON、普通 HTML 维护页不被误判为 WAF
 *   3. 错误文案能区分「被拦截（建议换节点）」「会话失效」「限流」
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/net/httpClient.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/httpClient.cjs',
  logLevel: 'error'
})
await build({
  entryPoints: ['src/renderer/src/lib/format.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/format2.cjs',
  external: ['@shared/types'],
  logLevel: 'error'
})

const { wafBlocked } = require('../.tmp/httpClient.cjs')
const { describeStatusError } = require('../.tmp/format2.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// 实测抓到的真实响应片段
const ALIYUN_WAF = `<!doctype html> <meta charset="UTF-8">
<meta name="aliyun_waf_aa" content="ff926c7f07e45e2e487a29a6197d3460">
<meta name="aliyun_waf_bb" content="eade71455e2ad9c6d08b82bc7d98df8c">
<title></title><script>/* v2.0.1 */!function(){var __webpack_modules__={340:function(){}}}</script>`

check('识别阿里云 WAF 指纹页', wafBlocked(ALIYUN_WAF) === true)
check(
  '识别旧版 acw_sc__v2 质询（arg1）',
  wafBlocked(`<script>var arg1='A1B2C3D4E5F6'</script>`) === true
)
check(
  '识别 Cloudflare 挑战页',
  wafBlocked('<title>Just a moment...</title>') === true
)
check(
  '识别中文安全验证页',
  wafBlocked('<title>安全验证</title>') === true
)
check('正常 JSON 不误判', wafBlocked('{"success":true,"data":{"quota":100}}') === false)
check('普通 HTML 维护页不误判为 WAF', wafBlocked('<html><body>维护中</body></html>') === false)
check('空串不误判', wafBlocked('') === false)

// ---- 错误文案 ----
check(
  'WAF 拦截 → 建议换节点',
  describeStatusError({ ok: false, error: '站点防护拦截（当前代理节点被风控），请更换节点后重试' }) ===
    '节点被拦截，换节点试试',
  describeStatusError({ ok: false, error: '站点防护拦截（当前代理节点被风控），请更换节点后重试' })
)
check(
  '会话失效 → 会话失效',
  describeStatusError({ ok: false, error: '会话已失效，需要重新授权' }) === '会话失效，需重新授权'
)
check(
  '限流 → 站点限流',
  describeStatusError({ ok: false, error: '站点限流（429），请稍后再试' }) === '站点限流，稍后再试'
)
check(
  '有旧数据时点明是上次数据',
  describeStatusError({ ok: false, error: '响应结构无法识别', available: 730.22 }) ===
    '刷新失败（显示上次数据）',
  describeStatusError({ ok: false, error: '响应结构无法识别', available: 730.22 })
)
check(
  '无旧数据时展示原因摘要',
  describeStatusError({ ok: false, error: '响应结构无法识别' }) === '响应结构无法识别'
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
