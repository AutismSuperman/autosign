/**
 * 会话自愈逻辑测试。
 *
 * 用本地 HTTP 服务模拟站点，覆盖五条关键分支：
 *   1. 401 → 用 refresh cookie 续期 → 重试成功
 *   2. 并发 401 只续期一次（避免重复消费 refresh cookie 把账号踢下线）
 *   3. 409 AUTH_SESSION_LIMIT 立即停止，不重试、不续期
 *   4. 503 瞬时抖动对幂等 GET 重试
 *   5. POST 不重放（签到绝不重复提交）
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

// 先把被测模块单独打成 CJS（应用 bundle 是入口，不导出内部模块）
mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/session.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/session.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { requestWithHealing, needsRefresh, isSessionLimit, isSessionDead } = require('../.tmp/session.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

let refreshCalls = 0
let selfCalls = 0
let checkinCalls = 0
let mode = 'normal'

const server = http.createServer((req, res) => {
  const url = req.url || ''
  if (url.startsWith('/api/user/auth/refresh')) {
    refreshCalls++
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': ['session=new-cookie; Path=/']
    })
    res.end(JSON.stringify({ success: true, data: { access_token: 'tok-new' } }))
    return
  }
  if (url.startsWith('/api/user/self')) {
    selfCalls++
    const auth = req.headers.authorization || ''
    if (mode === 'limit') {
      res.writeHead(409)
      res.end(JSON.stringify({ code: 'AUTH_SESSION_LIMIT' }))
      return
    }
    if (mode === 'flaky' && selfCalls <= 2) {
      res.writeHead(503)
      res.end('busy')
      return
    }
    if (auth === 'Bearer tok-new') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { quota: 500000, used_quota: 100000, id: 42 } }))
      return
    }
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, message: '未登录' }))
    return
  }
  if (url.startsWith('/api/user/checkin')) {
    checkinCalls++
    const ok = (req.headers.authorization || '') === 'Bearer tok-new'
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify(
        ok ? { success: true, data: { quota_awarded: 500000 } } : { success: false, message: '未登录' }
      )
    )
    return
  }
  res.writeHead(404)
  res.end()
})

const listen = (srv) =>
  new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)))

const port = await listen(server)
const site = {
  id: 's1',
  name: 'Test',
  baseUrl: `http://127.0.0.1:${port}`,
  mode: 'BUTTON',
  kind: 'NEWAPI',
  provider: 'github',
  accounts: []
}
let account = {
  id: 'a1',
  siteId: 's1',
  label: 'acc',
  provider: 'github',
  cookie: 'session=old-cookie',
  token: 'tok-old',
  createdAt: 0
}
const patches = []
const deps = {
  proxy: '',
  onRenewed: async (_id, patch) => {
    patches.push(patch)
    account = { ...account, ...patch }
  },
  readAccount: () => account,
  log: () => {}
}

// 1) JWT 有效期判断
check('needsRefresh: 无 token 时应续期', needsRefresh(undefined) === true)
check('needsRefresh: 非 JWT 视为不需要', needsRefresh('opaque-token') === false)

// 2) 401 → 续期 → 重试成功
refreshCalls = 0
selfCalls = 0
mode = 'normal'
account = { ...account, token: 'tok-old', cookie: 'session=old-cookie' }
patches.length = 0
const r1 = await requestWithHealing(site, account, 'GET', '/api/user/self', deps)
check(
  '401 后自动续期并重试成功',
  r1.status === 200 && r1.token === 'tok-new',
  `status=${r1.status} token=${r1.token} refreshCalls=${refreshCalls}`
)
check('续期回写轮换后的 cookie', patches.some((p) => p.cookie && p.cookie.includes('new-cookie')))
check('续期回写新 token', patches.some((p) => p.token === 'tok-new'))

// 3) 并发只续期一次
refreshCalls = 0
account = { ...account, token: 'tok-old', cookie: 'session=old-cookie' }
const [ra, rb] = await Promise.all([
  requestWithHealing(site, account, 'GET', '/api/user/self', deps),
  requestWithHealing(site, account, 'GET', '/api/user/self', deps)
])
check('并发续期合并为一次', refreshCalls === 1, `refreshCalls=${refreshCalls}`)
check('两个并发请求都成功', ra.status === 200 && rb.status === 200)

// 4) 409 立即停止
refreshCalls = 0
selfCalls = 0
mode = 'limit'
account = { ...account, token: 'tok-old' }
const r4 = await requestWithHealing(site, account, 'GET', '/api/user/self', deps)
check(
  '409 会话上限立即返回不续期',
  r4.status === 409 && refreshCalls === 0,
  `status=${r4.status} refreshCalls=${refreshCalls}`
)

// 5) 503 抖动重试
refreshCalls = 0
selfCalls = 0
mode = 'flaky'
account = { ...account, token: 'tok-new' }
const r5 = await requestWithHealing(site, account, 'GET', '/api/user/self', deps)
check(
  '503 抖动对 GET 重试后成功',
  r5.status === 200 && selfCalls === 3,
  `status=${r5.status} selfCalls=${selfCalls}`
)

// 6) POST 不重放
mode = 'normal'
checkinCalls = 0
account = { ...account, token: 'tok-new', cookie: 'session=new-cookie' }
const r6 = await requestWithHealing(site, account, 'POST', '/api/user/checkin', deps, '{}')
check('POST 不重放（只发一次）', checkinCalls === 1, `checkinCalls=${checkinCalls} status=${r6.status}`)

// 7) 分类函数
check('isSessionLimit 识别 409', isSessionLimit(409, '') === true)
check(
  'isSessionLimit 识别 AUTH_SESSION_LIMIT',
  isSessionLimit(200, '{"code":"AUTH_SESSION_LIMIT"}') === true
)
check('isSessionDead 识别 401', isSessionDead(401, '{"message":"未登录"}') === true)
check('isSessionDead 不误判 200', isSessionDead(200, 'ok') === false)

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${results.length} checks)`)
server.close()
process.exit(failed.length === 0 ? 0 : 1)
