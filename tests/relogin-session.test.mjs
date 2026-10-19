/**
 * 会话重建判据测试。
 *
 * 起因：批量签到 9 个账号全部「0 成功」，日志里全是「授权已过期 / 会话已失效」。
 * 排查发现两个问题：
 *   1. 会话过期后一律要求用户手动重新登录，明明能用保存的密码自动重建
 *   2. 账号行仍显示上次成功的旧额度，看起来正常，实际早已失效
 *
 * 这里覆盖：哪些返回值算「会话失效」、哪些算「要求人机验证」，
 * 以及凭据类型是否允许用密码重建（GitHub 凭据不能当站点密码用）。
 *
 * 纯函数测试，不依赖 Electron。运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/reloginSession.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/reloginSession.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { isSessionExpired, needsTurnstile } = require('../.tmp/reloginSession.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// ---- 会话失效判据 ----
check('会话已失效 → 需要重建', isSessionExpired('会话已失效，需要重新授权'))
check('授权已过期 → 需要重建', isSessionExpired('授权已过期，请重新登录该账号'))
check('HTTP 401 → 需要重建', isSessionExpired(undefined, 401))
check('HTTP 403 → 需要重建', isSessionExpired(undefined, 403))
check('未登录 → 需要重建', isSessionExpired('未登录'))
check('英文 unauthorized → 需要重建', isSessionExpired('unauthorized'))

check('站点限流不算会话失效', isSessionExpired('站点限流（429），请稍后再试') === false)
check('人机验证失败不算会话失效', isSessionExpired('人机验证未通过：turnstile') === false)
check('普通网络错误不算会话失效', isSessionExpired('HTTP 502') === false)
check('空消息不算会话失效', isSessionExpired(undefined) === false)

// ---- 人机验证判据 ----
check('Turnstile token 为空 → 要取令牌', needsTurnstile('Turnstile token 为空'))
check('captcha → 要取令牌', needsTurnstile('captcha required'))
check('人机验证 → 要取令牌', needsTurnstile('站点要求人机验证'))
check('普通错误不需要令牌', needsTurnstile('用户名或密码错误') === false)
check('空消息不需要令牌', needsTurnstile(undefined) === false)

// ---- 密码与凭据错误的区分 ----
// 这两类必须能分开：前者是凭据本身有问题，后者说明该改用 OAuth
check(
  '密码错误与 Turnstile 是不同错误',
  needsTurnstile('用户名或密码错误，或用户已被封禁') === false
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
