/**
 * 提交前敏感信息自检。
 *
 * 规则见 AGENTS.md「二、账号与凭据保密要求」。
 * 检查暂存区（或指定提交）里的文件，发现疑似账号凭据就失败。
 *
 * 运行：
 *   node scripts/check-secrets.mjs          # 检查暂存区
 *   node scripts/check-secrets.mjs --all    # 检查全部跟踪文件
 *   node scripts/check-secrets.mjs --tree <rev>  # 检查某个提交的文件树
 *
 * 只做静态模式匹配，可能有误报；命中时人工确认再放行。
 */
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const mode = args.includes('--all') ? 'all' : args.includes('--tree') ? 'tree' : 'staged'
const rev = args[args.indexOf('--tree') + 1]

function git(...cmd) {
  return execFileSync('git', cmd, { encoding: 'utf8' })
}

/** 要扫描的文件列表。 */
function filesToScan() {
  if (mode === 'all') return git('ls-files').split('\n').filter(Boolean)
  if (mode === 'tree') return git('ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean)
  // 暂存区：新增/修改的文件（排除删除）
  return git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
    .split('\n')
    .filter(Boolean)
}

/** 绝不应当被跟踪的路径。 */
const FORBIDDEN_PATHS = [
  /(^|\/)\.?[^/]*-user-data\//, // Electron 用户数据目录
  /(^|\/)\.?[^/]*\.shot[^/]*-data\//,
  /(^|\/)\.tmp\//,
  /(^|\/)node_modules\//,
  /(^|\/)out\//,
  /(^|\/)dist\//,
  /(^|\/)Cookies$/, // Chromium cookie 文件
  /(^|\/)Local Storage\//,
  /(^|\/)Network\/Cookies/,
  /(^|\/)\.env$/,
  /(^|\/)\.env\./
]

/** 文件内容里不应出现的模式。 */
const FORBIDDEN_CONTENT = [
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, name: 'GitHub 个人访问令牌' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, name: 'GitHub 细粒度令牌' },
  { re: /\bsk-[A-Za-z0-9]{24,}\b/, name: '疑似 API Key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, name: 'JWT 令牌' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS Access Key' },
  // 真实邮箱：排除示例域名与常见占位符
  {
    re: /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org|net))[A-Za-z0-9.-]+\.(com|cn|net|org|icu|top|io|dev)\b/,
    name: '疑似真实邮箱'
  },
  // 含用户名的绝对路径
  { re: /[A-Za-z]:\\\\?Users\\\\?(?!<)[A-Za-z0-9._-]{3,}/, name: 'Windows 用户目录绝对路径' },
  { re: /\/Users\/[A-Za-z0-9._-]{3,}\/(?!\*)/, name: 'macOS 用户目录绝对路径' }
]

/** 允许出现的邮箱（文档与示例保留域名、依赖作者）。 */
const EMAIL_ALLOWLIST = [
  /@example\.(com|org|net)$/i,
  /^noreply@/i,
  /^no-reply@/i
]

/** 这些文件本身是扫描器，跳过内容扫描避免自指误报。 */
const SELF_REFERENTIAL = /scripts\/check-secrets\.mjs$/

function stripAllowlisted(text) {
  let out = text
  for (const re of EMAIL_ALLOWLIST) {
    out = out.replace(new RegExp(re.source, 'gi'), '[allowed-email]')
  }
  return out
}

const problems = []
const files = filesToScan()

for (const file of files) {
  // 路径检查
  for (const re of FORBIDDEN_PATHS) {
    if (re.test(file)) {
      problems.push({ file, rule: '不应跟踪的路径', detail: file })
      break
    }
  }
  if (SELF_REFERENTIAL.test(file)) continue

  // 内容检查：只读文本文件，跳过二进制
  let content
  try {
    content =
      mode === 'staged'
        ? git('show', `:${file}`)
        : mode === 'tree'
          ? git('show', `${rev}:${file}`)
          : execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' })
  } catch {
    continue
  }
  if (!content || content.includes('\u0000')) continue // 二进制

  const scanned = stripAllowlisted(content)
  for (const rule of FORBIDDEN_CONTENT) {
    const m = rule.re.exec(scanned)
    if (!m) continue
    // 定位到行号，便于修正
    const idx = scanned.indexOf(m[0])
    const line = scanned.slice(0, Math.max(0, idx)).split('\n').length
    problems.push({
      file,
      line,
      rule: rule.name,
      detail: m[0].slice(0, 40) + (m[0].length > 40 ? '…' : '')
    })
  }
}

if (problems.length === 0) {
  console.log(`✓ 敏感信息自检通过（${files.length} 个文件）`)
  process.exit(0)
}

console.error(`✗ 发现 ${problems.length} 处疑似敏感信息：\n`)
for (const p of problems) {
  const where = p.line ? `${p.file}:${p.line}` : p.file
  console.error(`  ${where}`)
  console.error(`    规则：${p.rule}`)
  console.error(`    内容：${p.detail}\n`)
}
console.error('请按 AGENTS.md「二、账号与凭据保密要求」处理后再提交。')
console.error('若确认是误报，请调整写法（用 example.com 等示例值），不要绕过检查。')
process.exit(1)
