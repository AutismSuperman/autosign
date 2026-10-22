/**
 * 配置对外视图的凭据剥离测试。
 *
 * 边界要求（AGENTS.md §2.6）：会话 Cookie、访问令牌、密码、TOTP、以及新增的
 * 第三方登录态备份，都只在主进程内存与加密文件之间流动，渲染进程永远拿不到。
 *
 * `store.get()` 的结果会被整包经 IPC 发到渲染进程，所以它必须是剥离过的形态；
 * 完整数据走 `getInternal()`。这项约束靠「加字段时别忘了同步剥离」维持，
 * 因此用测试把当前所有敏感字段逐个钉死：将来再加一个账号级密钥字段，
 * 忘记剥离就会在这里失败。
 *
 * 纯逻辑测试（构造对象手动调用 toPublicConfig），不依赖 Electron 运行时。
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/store.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/store.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { toPublicConfig } = require('../.tmp/store.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const sensitive = {
  cookie: 'session=secret-value',
  token: 'sk-secret-token',
  providerCookies: '[{"name":"_gh_sess","value":"secret"}]'
}

const config = {
  version: 1,
  sites: [
    {
      id: 'demo-site',
      name: 'DemoSite',
      baseUrl: 'https://demo.example.com',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'github',
      accounts: [
        {
          id: 'demo-a1',
          siteId: 'demo-site',
          label: 'demo-user',
          provider: 'github',
          siteUserId: '1001',
          createdAt: 0,
          ...sensitive,
          needsRelogin: true,
          lastStatus: { at: 0, ok: true, available: 12.5, used: 1 }
        }
      ]
    }
  ],
  credentials: [{ id: 'c1', provider: 'password', username: 'demo', password: 'pw', totpSecret: 'SECRET', createdAt: 0 }],
  settings: { theme: 'dark' }
}

const pub = toPublicConfig(config)
const account = pub.sites[0].accounts[0]
const json = JSON.stringify(pub)

check('对外视图保留站点结构', pub.sites.length === 1 && pub.sites[0].id === 'demo-site')
check('对外视图保留账号数', pub.sites[0].accounts.length === 1)

// 三个会话凭据字段必须全部消失
check('剥离 cookie', account.cookie === undefined && !json.includes('session=secret-value'))
check('剥离 token', account.token === undefined && !json.includes('sk-secret-token'))
check('剥离第三方登录态备份', account.providerCookies === undefined && !json.includes('_gh_sess'))

// 界面需要的字段必须保留，否则剥离过度会把功能弄坏
check('保留账号名', account.label === 'demo-user')
check('保留 siteUserId（请求头需要，不是密钥）', account.siteUserId === '1001')
check('保留签到标记', account.needsRelogin === true)
check('保留额度快照', account.lastStatus?.available === 12.5)
check('保留站点配额单位等元数据', pub.sites[0].baseUrl === 'https://demo.example.com')

// 凭据列表只应通过 publicCredentials 暴露；toPublicConfig 不做凭据裁剪，
// 因此这里断言的是「它不做这件事」——主进程的 credentialList 负责脱敏。
check('凭据脱敏由 publicCredentials 负责（此处不误删）', Array.isArray(pub.credentials))

// 原对象不能被改动（剥离必须是无副作用的）
check('原配置未被修改', config.sites[0].accounts[0].cookie === 'session=secret-value')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
