import { useEffect, useMemo, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Info,
  RefreshCw,
  ScrollText,
  Search,
  Trash2
} from 'lucide-react'
import type { LogEntry, LogLevel, Site } from '@shared/types'
import { MaskedText } from './MaskedText'
import { Seg } from './Seg'
import { containsIdentifier, splitByIdentifiers } from '../lib/mask'
import { useConfirm } from './ConfirmDialog'

interface Props {
  logs: LogEntry[]
  /** 站点与账号：把日志里的 id 翻成可读名称。 */
  sites: Site[]
  /** 账号打码：日志正文里出现的账号标识同样遮住。 */
  maskAccounts?: boolean
  onReload: () => void
  onClear: () => void
}

/** 每页条数。日志条目密集，分页比无限滚动更容易定位。 */
const PAGE_SIZE = 30

function fmt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`
}

const LEVEL_ICON: Record<LogLevel, typeof Info> = {
  info: Info,
  ok: CircleCheck,
  warn: CircleAlert,
  err: CircleX
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  info: '信息',
  ok: '成功',
  warn: '警告',
  err: '错误'
}

type LevelFilter = LogLevel | 'all'

const FILTERS: Array<{ key: LevelFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'info', label: '信息' },
  { key: 'ok', label: '成功' },
  { key: 'warn', label: '警告' },
  { key: 'err', label: '错误' }
]

/** 运行日志。detail 中不包含任何凭据原文（主进程写日志前已脱敏）。 */
export function LogsView({ logs, sites, maskAccounts, onReload, onClear }: Props): React.JSX.Element {
  const [level, setLevel] = useState<LevelFilter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  /** 展开详情的日志 id 集合。详情段落较宽，默认收起避免刷屏。 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const { confirm, dialog } = useConfirm()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logs.filter((l) => {
      if (level !== 'all' && l.level !== level) return false
      if (!q) return true
      return (
        l.message.toLowerCase().includes(q) ||
        l.scope.toLowerCase().includes(q) ||
        (l.detail ?? '').toLowerCase().includes(q)
      )
    })
  }, [logs, level, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  // 过滤条件变化或日志被清空后，页码可能越界：夹到合法范围
  const safePage = Math.min(page, pageCount)
  const pageItems = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  )

  // 切换过滤条件时回到第一页，否则会停在一个不存在的页码上
  useEffect(() => {
    setPage(1)
  }, [level, query])

  const toggleDetail = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * 账号标识的渲染。
   *
   * 日志正文是主进程拼好的整句，无法从文本判断哪一段是账号，
   * 因此用已知账号名做字面量匹配，命中后替换成遮罩块——原始字符
   * 完全不进入 DOM，截图和查看元素都拿不到。
   */
  const identifiers = useMemo(() => {
    if (!maskAccounts) return []
    return sites.flatMap((s) => s.accounts.map((a) => a.label))
  }, [sites, maskAccounts])

  /** 把一句话里的账号标识替换成遮罩块；没有命中时原样返回字符串。 */
  const renderText = (text: string): React.ReactNode => {
    if (!maskAccounts || !containsIdentifier(text, identifiers)) return text
    return splitByIdentifiers(text, identifiers).map((seg, i) =>
      seg.kind === 'mask' ? (
        <MaskedText key={`m${i}`} value={seg.value} size="sm" />
      ) : (
        <span key={`t${i}`}>{seg.value}</span>
      )
    )
  }

  /** 日志只记 id，展开详情时翻成名称；找不到时退回 id，不让详情空着。 */
  const siteNameOf = (siteId: string): string =>
    sites.find((s) => s.id === siteId)?.name ?? siteId

  const accountLabelOf = (accountId: string): React.ReactNode => {
    for (const site of sites) {
      const hit = site.accounts.find((a) => a.id === accountId)
      if (hit) {
        return (
          <>
            {maskAccounts ? <MaskedText value={hit.label} size="sm" /> : hit.label}
            （{site.name}）
          </>
        )
      }
    }
    return accountId
  }

  const confirmClear = async (): Promise<void> => {
    const ok = await confirm({
      title: '清空日志？',
      danger: true,
      confirmLabel: '清空',
      message: <>将删除全部 {logs.length} 条运行日志，此操作不可撤销。</>
    })
    if (ok) onClear()
  }

  return (
    <>
      <div className="topbar">
        <span className="topbar-icon">
          <ScrollText size={16} />
        </span>
        <h1>运行日志</h1>
        <span className="sub">
          {filtered.length === logs.length
            ? `${logs.length} 条`
            : `${filtered.length} / ${logs.length} 条`}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={onReload} title="重新读取日志">
          <RefreshCw size={14} />
          刷新
        </button>
        <button
          className="btn ghost"
          onClick={() => void confirmClear()}
          disabled={logs.length === 0}
          title="清空全部日志"
        >
          <Trash2 size={14} />
          清空
        </button>
      </div>
      <div className="content">
        <div className="log-toolbar">
          <Seg value={level} items={FILTERS} onChange={setLevel} ariaLabel="日志级别" />
          <div className="search-box">
            <Search size={14} />
            <input
              placeholder="搜索日志内容…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {pages(safePage, pageCount, setPage)}
        </div>

        <div className="panel">
          {logs.length === 0 && (
            <div className="cred-empty">
              <ScrollText size={36} strokeWidth={1.4} className="empty-icon" />
              <div>暂无日志。签到、登录与调度都会记录在这里。</div>
            </div>
          )}
          {logs.length > 0 && filtered.length === 0 && (
            <div className="cred-empty">
              <Search size={36} strokeWidth={1.4} className="empty-icon" />
              <div>没有匹配的日志，调整过滤条件试试。</div>
            </div>
          )}
          {pageItems.map((log) => {
            const Icon = LEVEL_ICON[log.level] ?? Info
            const open = expanded.has(log.id)
            // 任何日志都能展开：detail 只是其一，站点/账号/时间同样是排查线索
            return (
              <div className={`log-row ${log.level}`} key={log.id}>
                <span className="log-time">{fmt(log.at)}</span>
                <span className="log-scope">
                  <Icon size={13} className="log-icon" />
                  {log.scope}
                </span>
                <span className="log-msg">
                  {renderText(log.message)}
                  {log.detail && <div className="log-detail">{renderText(log.detail)}</div>}
                  {open && (
                    <div className="log-extra">
                      <div>
                        <span className="log-extra-key">时间</span>
                        {fmt(log.at)}
                      </div>
                      <div>
                        <span className="log-extra-key">级别</span>
                        {LEVEL_LABEL[log.level] ?? log.level}
                      </div>
                      <div>
                        <span className="log-extra-key">分类</span>
                        {log.scope}
                      </div>
                      {log.siteId && (
                        <div>
                          <span className="log-extra-key">站点</span>
                          {siteNameOf(log.siteId)}
                        </div>
                      )}
                      {log.accountId && (
                        <div>
                          <span className="log-extra-key">账号</span>
                          {accountLabelOf(log.accountId)}
                        </div>
                      )}
                      {log.detail && (
                        <div>
                          <span className="log-extra-key">详情</span>
                          {renderText(log.detail)}
                        </div>
                      )}
                    </div>
                  )}
                </span>
                <button
                  className="btn small log-detail-btn"
                  onClick={() => toggleDetail(log.id)}
                  aria-expanded={open}
                  title={open ? '收起详情' : '查看详情'}
                >
                  {open ? '收起' : '详情'}
                </button>
              </div>
            )
          })}
        </div>

        {pageCount > 1 && <div className="log-pager-bottom">{pages(safePage, pageCount, setPage)}</div>}
      </div>
      {dialog}
    </>
  )
}

/** 页码控制。条数不足一页时不渲染，避免占位。 */
function pages(
  page: number,
  pageCount: number,
  setPage: (n: number) => void
): React.JSX.Element | null {
  if (pageCount <= 1) return null
  return (
    <div className="pager">
      <button
        className="icon-btn"
        onClick={() => setPage(Math.max(1, page - 1))}
        disabled={page <= 1}
        title="上一页"
      >
        <ChevronLeft size={15} />
      </button>
      <span className="pager-text tabular">
        {page} / {pageCount}
      </span>
      <button
        className="icon-btn"
        onClick={() => setPage(Math.min(pageCount, page + 1))}
        disabled={page >= pageCount}
        title="下一页"
      >
        <ChevronRight size={15} />
      </button>
    </div>
  )
}
