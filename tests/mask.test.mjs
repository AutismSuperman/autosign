/**
 * 账号打码的文案处理测试。
 *
 * 打码只影响显示，不能改变数据：这里断言的是「显示出来的字符串」，
 * 顺带验证短串、邮箱、日志正文替换的边界。
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/renderer/src/lib/format.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/format.cjs',
  logLevel: 'error',
  alias: { '@shared': './src/shared' }
})
const { maskIdentifier, maskLogMessage } = require('../.tmp/format.cjs')

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// --- maskIdentifier ---

const gh = maskIdentifier('github_679839')
ck('长账号保留首尾字符', gh.startsWith('g') && gh.endsWith('9') && gh.includes('*'), gh)
ck('长账号中间被遮住', !gh.includes('github') && !gh.includes('67983'), gh)

const email = maskIdentifier('demo-user@example.com')
ck('邮箱保留域名', email.endsWith('@example.com'), email)
ck('邮箱本地部分被遮', !email.includes('demo-user'), email)

const short = maskIdentifier('ab')
ck('两个字符全遮', short === '**', short)

const three = maskIdentifier('abc')
ck('三到四个字符保留首尾', three === 'a*c', three)

const phone = maskIdentifier('13800001111')
ck('纯数字同样打码', phone.startsWith('1') && phone.includes('*') && !phone.includes('0000'), phone)

ck('空值返回空串', maskIdentifier('') === '' && maskIdentifier(undefined) === '' && maskIdentifier(null) === '')

const cjk = maskIdentifier('张三丰')
ck('中文按字符打码', cjk.startsWith('张') && cjk.includes('*'), cjk)

// --- maskLogMessage ---

const logs = [
  'AgentRouter / github_679839：签到成功 +$25',
  'AgentRouter / github_679839：会话已失效',
  '已登录 demo-user@example.com',
  'DemoSite：刷新失败'
]
const identifiers = ['github_679839', 'demo-user@example.com']
const masked = logs.map((m) => maskLogMessage(m, identifiers, maskIdentifier))

ck('站点名保持不变', masked[0].startsWith('AgentRouter / '), masked[0])
ck('日志里的账号被遮', !masked[0].includes('github_679839'), masked[0])
ck('结果描述保持不变', masked[0].endsWith('签到成功 +$25'), masked[0])
ck('邮箱账号也被遮', !masked[2].includes('demo-user@example.com'), masked[2])
ck('无账号的日志原样保留', masked[3] === logs[3], masked[3])
ck(
  '所有日志均不含原始标识',
  masked.every((m, i) => !identifiers.some((id) => m.includes(id)) && m !== undefined),
  masked.map((m, i) => (m === logs[i] ? 'unchanged' : 'masked')).join(',')
)

// 长串优先：短标识是长标识的前缀时不能把长标识切碎后漏掉后半段
const overlap = maskLogMessage('x user_123 y', ['user', 'user_123'], maskIdentifier)
ck('重叠标识按长串优先替换', !overlap.includes('user_123'), overlap)

ck('空标识清单时原样返回', maskLogMessage('abc', [], maskIdentifier) === 'abc')

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
process.exit(failed === 0 ? 0 : 1)
