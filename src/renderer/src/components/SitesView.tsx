import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  CalendarCheck,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  GripVertical,
  KeyRound,
  LogIn,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Zap
} from 'lucide-react'
import type {
  AccountSort,
  ApiKey,
  PublicCredential,
  Site,
  SiteSort,
  SortDirection
} from '@shared/types'
import { useConfirm } from './ConfirmDialog'
import { EditSiteDialog } from './EditSiteDialog'
import { Select } from './Select'
import type { ToastKind } from './Toast'
import { copyText } from '../lib/clipboard'
import {
  KIND_LABEL,
  MODE_LABEL,
  PROVIDER_SHORT,
  checkinLabel,
  checkinText,
  describeStatusError,
  isSessionExpired,
  money,
  timeAgo
} from '../lib/format'
import { ACCOUNT_SORT_LABEL, sortSiteAccounts } from '../lib/sort'
import { useSiteIcon } from '../lib/useSiteIcon'

interface Props {
  sites: Site[]
  allSites: Site[]
  /** 凭据列表：用于在账号行标注这次登录用的是哪个账号。 */
  credentials: PublicCredential[]
  /** 正在进行的任务键集合；同一时刻可能有多个账号各自在处理。 */
  busy: Set<string>
  /** 批量签到进度：用于在账号行就地标出正在签谁、已完成多少。 */
  batchProgress: { done: number; total: number; current: string } | null
  /** 侧栏选中了哪个站点；null 表示全部站点。 */
  activeSiteId: string | null
  /** 拖拽重排站点内账号。 */
  onReorderAccounts: (siteId: string, accountIds: string[]) => void
  /** 站点列表顺序由 App 统一排（拖拽/上下移改的是配置顺序）。 */
  siteSort: SiteSort
  siteSortDir: SortDirection
  accountSort: AccountSort
  accountSortDir: SortDirection
  onAccountSortChange: (sort: AccountSort, dir: SortDirection) => void
  onAddSite: () => void
  onLogin: (siteId: string) => void
  /** 重新授权已有账号：用新的 OAuth 会话替换该账号的失效会话。 */
  onReauth: (siteId: string, accountId: string) => void
  onRefreshAccount: (accountId: string) => void
  onCheckin: (accountId: string) => void
  onRemoveAccount: (accountId: string) => void
  onRemoveSite: (siteId: string) => void
  onUpdateSite: (siteId: string, patch: Partial<Site>) => void
  onCheckinAll: () => void
  onReorderSites: (siteIds: string[]) => void
  onRefreshAll: () => void
  onToast: (message: string, kind?: ToastKind) => void
}

/** 站点卡片头像：有 logo 用 logo，否则用首字母。 */
function SiteAvatar({ site }: { site: Site }): React.JSX.Element {
  const icon = useSiteIcon(site.baseUrl)
  if (icon) {
    return (
      <span className="site-avatar has-logo">
        <img src={icon} alt="" aria-hidden="true" />
      </span>
    )
  }
  return <span className="site-avatar">{site.name.slice(0, 1).toUpperCase()}</span>
}

/** 站点与账号主视图。 */
export function SitesView(props: Props): React.JSX.Element {
  const { allSites } = props
  const totalAccounts = allSites.reduce((n, s) => n + s.accounts.length, 0)
  const [dragId, setDragId] = useState<string | null>(null)
  /** 正在拖拽的账号 id，用于站点内账号排序。 */
  const [dragAccountId, setDragAccountId] = useState<string | null>(null)
  const [editSite, setEditSite] = useState<Site | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /**
   * API Key 列表状态，按账号存。
   *
   * Key 是敏感数据且要额外请求一次，所以只在用户点开时拉取，
   * 不随额度刷新自动加载。
   */
  const [keyLists, setKeyLists] = useState<
    Record<string, { loading: boolean; keys: ApiKey[]; error?: string }>
  >({})
  const { confirm, dialog } = useConfirm()

  /** 自定义顺序以外的排序下，拖拽与上下移没有明确语义，禁用并给出提示。 */
  const manualOrder = props.siteSort === 'custom'
  /** 账号拖拽只在「登录顺序」下有意义，其余排序是计算出来的。 */
  const manualAccountOrder = props.accountSort === 'custom'

  const changeAccountSort = (sort: AccountSort): void => {
    // 名称默认 A→Z，金额与刷新时间默认从高到低
    props.onAccountSortChange(sort, sort === 'name' ? 'asc' : 'desc')
  }

  /** 展开/收起某个账号的 Key 列表；首次展开时才去请求。 */
  const toggleKeys = async (accountId: string): Promise<void> => {
    const current = keyLists[accountId]
    if (current && !current.error) {
      // 已加载过：收起
      setKeyLists((prev) => {
        const next = { ...prev }
        delete next[accountId]
        return next
      })
      return
    }
    setKeyLists((prev) => ({ ...prev, [accountId]: { loading: true, keys: [] } }))
    const r = await window.api.account.keys(accountId)
    setKeyLists((prev) => ({
      ...prev,
      [accountId]: { loading: false, keys: r.keys, error: r.ok ? undefined : r.error }
    }))
  }

  /** 把被拖的账号插到目标账号的位置。 */
  const dropAccountOn = (site: Site, targetAccountId: string): void => {
    if (!dragAccountId || dragAccountId === targetAccountId) return
    const ids = site.accounts.map((a) => a.id)
    const from = ids.indexOf(dragAccountId)
    const to = ids.indexOf(targetAccountId)
    if (from < 0 || to < 0) return
    const next = [...ids]
    next.splice(from, 1)
    next.splice(to, 0, dragAccountId)
    props.onReorderAccounts(site.id, next)
    setDragAccountId(null)
  }

  /** 账号行上标注的登录账号：优先用绑定凭据的显示名称，没有绑定则不显示。 */
  const credentialOf = (credentialId: string | undefined): PublicCredential | undefined =>
    credentialId ? props.credentials.find((c) => c.id === credentialId) : undefined

  /**
   * 检索：站点名、域名、账号名/备注、所属凭据的显示名称与用户名都参与匹配。
   * 命中账号时保留整个站点卡片，用户能同时看到同站其它账号的上下文。
   */
  const visibleSites = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return props.sites
    return props.sites.filter((site) => {
      if (site.name.toLowerCase().includes(q) || site.baseUrl.toLowerCase().includes(q)) return true
      return site.accounts.some((account) => {
        if (account.label.toLowerCase().includes(q)) return true
        const cred = credentialOf(account.credentialId)
        if (!cred) return false
        return (
          cred.username.toLowerCase().includes(q) ||
          (cred.displayName ?? '').toLowerCase().includes(q) ||
          (cred.note ?? '').toLowerCase().includes(q)
        )
      })
    })
  }, [props.sites, props.credentials, query])

  // 侧栏选中站点后，卡片换成了另一张，短暂高亮提示用户位置变了
  useEffect(() => {
    if (!props.activeSiteId) return
    setFlashId(props.activeSiteId)
    const t = window.setTimeout(() => setFlashId(null), 800)
    return () => window.clearTimeout(t)
  }, [props.activeSiteId])

  /** 上下移动：比拖拽更精确，也不需要处理跨平台拖放差异。 */
  const move = (siteId: string, delta: number): void => {
    const ids = allSites.map((s) => s.id)
    const from = ids.indexOf(siteId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    const next = [...ids]
    ;[next[from], next[to]] = [next[to], next[from]]
    props.onReorderSites(next)
  }

  /** 拖放排序：把被拖项插到目标项的位置。 */
  const dropOn = (targetId: string): void => {
    if (!dragId || dragId === targetId) return
    const ids = allSites.map((s) => s.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = [...ids]
    next.splice(from, 1)
    next.splice(to, 0, dragId)
    props.onReorderSites(next)
    setDragId(null)
  }

  const copyUrl = async (site: Site): Promise<void> => {
    const ok = await copyText(site.baseUrl)
    props.onToast(ok ? '站点地址已复制' : '复制失败', ok ? 'success' : 'error')
  }

  const confirmRemoveSite = async (site: Site): Promise<void> => {
    const ok = await confirm({
      title: '移除站点？',
      danger: true,
      confirmLabel: '移除',
      message: (
        <>
          将移除 <b>{site.name}</b>
          {site.accounts.length > 0 && (
            <>
              {' '}及其 <b>{site.accounts.length}</b> 个账号的会话数据
            </>
          )}
          ，此操作不可撤销。
        </>
      )
    })
    if (ok) props.onRemoveSite(site.id)
  }

  const confirmRemoveAccount = async (site: Site, accountId: string, label: string): Promise<void> => {
    const ok = await confirm({
      title: '移除账号？',
      danger: true,
      confirmLabel: '移除',
      message: (
        <>
          将移除 <b>{site.name}</b> 上的账号 <b>{label}</b> 的会话，登录凭据不受影响。
        </>
      )
    })
    if (ok) props.onRemoveAccount(accountId)
  }

  const siteCardClass = (site: Site): string => {
    const cls = ['site-card']
    if (site.hidden) cls.push('is-hidden')
    if (flashId === site.id) cls.push('flash')
    return cls.join(' ')
  }

  /** 选中的站点名；null 表示正在看全部站点。 */
  const scopeName = props.activeSiteId
    ? props.allSites.find((s) => s.id === props.activeSiteId)?.name ?? null
    : null

  const topbar = (
    <div className="topbar">
      <h1>{scopeName ?? '站点'}</h1>
      <span className="sub">
        {query.trim()
          ? `${visibleSites.length} / ${props.sites.length} 个站点`
          : `${props.sites.length} 个站点 · ${totalAccounts} 个账号`}
      </span>
      <span className="spacer" />
      <div className="search-box" style={{ width: 240 }}>
        <Search size={14} />
        <input
          placeholder="检索站点、账号或凭据…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="检索站点或账号"
        />
      </div>
      {/* 文案随范围变化，避免在单站点视图里误以为会处理全部站点 */}
      <button
        className="btn"
        onClick={props.onRefreshAll}
        disabled={totalAccounts === 0 || props.busy.has('refresh-all')}
        title={scopeName ? `刷新 ${scopeName} 的额度` : '刷新全部站点额度'}
      >
        {props.busy.has('refresh-all') ? (
          <RefreshCw size={14} className="rotating" />
        ) : (
          <RefreshCw size={14} />
        )}
        刷新额度
      </button>
      <button
        className="btn"
        onClick={props.onCheckinAll}
        disabled={totalAccounts === 0 || props.busy.has('checkin-all')}
        title={scopeName ? `签到 ${scopeName} 下的全部账号` : '签到全部站点的账号'}
      >
        {props.busy.has('checkin-all') ? (
          <RefreshCw size={14} className="rotating" />
        ) : (
          <Zap size={14} />
        )}
        {props.busy.has('checkin-all') ? '签到中…' : '全部签到'}
      </button>
      <button className="btn primary" onClick={props.onAddSite}>
        <Plus size={14} />
        添加站点
      </button>
    </div>
  )

  if (props.sites.length === 0) {
    return (
      <>
        {topbar}
        <div className="content">
          <div className="empty">
            <Globe size={42} strokeWidth={1.4} className="empty-icon" />
            <div className="empty-title">还没有可见的站点</div>
            <div>从内置目录添加站点，或在侧栏「显示全部」中恢复已隐藏的站点。</div>
            <button className="btn primary" onClick={props.onAddSite} style={{ marginTop: 6 }}>
              <Plus size={14} />
              添加站点
            </button>
          </div>
        </div>
        {dialog}
      </>
    )
  }

  return (
    <>
      {topbar}

      {props.batchProgress && (
        <div className="batch-bar" role="status" aria-live="polite">
          <RefreshCw size={14} className="rotating" />
          <span className="batch-text">
            正在签到 {props.batchProgress.done + 1} / {props.batchProgress.total}
            {props.batchProgress.current && (
              <b className="batch-current">{props.batchProgress.current}</b>
            )}
          </span>
          <span className="batch-track">
            <span
              className="batch-fill"
              style={{
                width: `${Math.round(
                  (props.batchProgress.done / Math.max(1, props.batchProgress.total)) * 100
                )}%`
              }}
            />
          </span>
        </div>
      )}

      <div className="content">
        {visibleSites.length === 0 && (
          <div className="empty">
            <Search size={38} strokeWidth={1.4} className="empty-icon" />
            <div className="empty-title">没有匹配的站点或账号</div>
            <div>试试站点名、域名、账号名，或凭据的邮箱。</div>
            <button className="btn" onClick={() => setQuery('')} style={{ marginTop: 6 }}>
              清除检索
            </button>
          </div>
        )}
        {visibleSites.map((site) => (
          <div
            className={siteCardClass(site)}
            id={`site-${site.id}`}
            key={site.id}
            draggable={manualOrder}
            onDragStart={() => setDragId(site.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => dropOn(site.id)}
            onDragEnd={() => setDragId(null)}
            style={{ opacity: dragId === site.id ? 0.5 : undefined }}
          >
            <div className="site-head">
              <span
                className={manualOrder ? 'drag-handle' : 'drag-handle is-locked'}
                title={manualOrder ? '拖动排序' : '当前为自动排序，切回「自定义顺序」后可拖动'}
              >
                <GripVertical size={15} />
              </span>
              <SiteAvatar site={site} />
              <span className="site-title">
                <span className="site-name">{site.name}</span>
                <span className="site-tags">
                  <span className="tag">{MODE_LABEL[site.mode]}</span>
                  <span className="tag">{KIND_LABEL[site.kind] ?? site.kind}</span>
                  {site.custom && <span className="tag">自定义</span>}
                  {site.hidden && <span className="tag warn">已隐藏</span>}
                </span>
              </span>
              <span className="spacer" />
              <span className="site-actions">
                <button
                  className="icon-btn"
                  onClick={() => move(site.id, -1)}
                  title="上移"
                  disabled={!manualOrder || allSites[0]?.id === site.id}
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => move(site.id, 1)}
                  title="下移"
                  disabled={!manualOrder || allSites[allSites.length - 1]?.id === site.id}
                >
                  <ChevronDown size={15} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => props.onUpdateSite(site.id, { hidden: !site.hidden })}
                  title={site.hidden ? '取消隐藏' : '从列表隐藏（数据保留）'}
                >
                  {site.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
                <button className="icon-btn" onClick={() => setEditSite(site)} title="编辑站点">
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-btn danger"
                  onClick={() => void confirmRemoveSite(site)}
                  title="移除站点及其账号"
                >
                  <Trash2 size={15} />
                </button>
              </span>
            </div>

            <div className="site-url-row">
              <span className="site-url" title={site.baseUrl}>
                {site.baseUrl}
              </span>
              <button className="icon-btn tiny" onClick={() => void copyUrl(site)} title="复制地址">
                <Copy size={12} />
              </button>
              <button
                className="icon-btn tiny"
                onClick={() => void window.api.app.openExternal(site.baseUrl)}
                title="在浏览器中打开"
              >
                <ExternalLink size={12} />
              </button>
            </div>

            {site.accounts.length === 0 && <div className="hint">尚未登录账号。</div>}

            {site.accounts.length > 1 && (
              <div className="account-sort-row">
                <span className="account-sort-label">账号排序</span>
                <span className="sort-control small">
                  <Select
                    value={props.accountSort}
                    options={(Object.keys(ACCOUNT_SORT_LABEL) as AccountSort[]).map((key) => ({
                      value: key,
                      label: ACCOUNT_SORT_LABEL[key]
                    }))}
                    onChange={changeAccountSort}
                    size="sm"
                    title="账号排序方式"
                    ariaLabel="账号排序方式"
                  />
                  <button
                    className="icon-btn tiny"
                    onClick={() =>
                      props.onAccountSortChange(
                        props.accountSort,
                        props.accountSortDir === 'desc' ? 'asc' : 'desc'
                      )
                    }
                    disabled={props.accountSort === 'custom'}
                    title={
                      props.accountSort === 'custom'
                        ? '登录顺序不受方向影响'
                        : props.accountSortDir === 'desc'
                          ? '当前从高到低，点击切换为从低到高'
                          : '当前从低到高，点击切换为从高到低'
                    }
                  >
                    {props.accountSortDir === 'desc' ? (
                      <ArrowDownWideNarrow size={13} />
                    ) : (
                      <ArrowUpNarrowWide size={13} />
                    )}
                  </button>
                </span>
              </div>
            )}

            {sortSiteAccounts(site.accounts, props.accountSort, props.accountSortDir).map((account) => {
              const status = account.lastStatus
              const checked = account.lastCheckin
              const refreshing = props.busy.has(`status:${account.id}`)
              const checking = props.busy.has(`checkin:${account.id}`)
              // 只认今天的回执：过了 0 点，昨天的成功不能算今天已签
              const checkin = checkinText(checked)
              const credential = credentialOf(account.credentialId)
              return (
                <div
                  className={checking ? 'account-row is-checking' : 'account-row'}
                  key={account.id}
                  draggable={manualAccountOrder}
                  onDragStart={() => setDragAccountId(account.id)}
                  onDragOver={(e) => {
                    if (manualAccountOrder) e.preventDefault()
                  }}
                  onDrop={() => dropAccountOn(site, account.id)}
                  onDragEnd={() => setDragAccountId(null)}
                  style={{ opacity: dragAccountId === account.id ? 0.5 : undefined }}
                >
                  <span
                    className={manualAccountOrder ? 'account-drag' : 'account-drag is-locked'}
                    title={
                      manualAccountOrder
                        ? '拖动调整账号顺序'
                        : '当前为自动排序，切回「登录顺序」后可拖动'
                    }
                  >
                    <GripVertical size={13} />
                  </span>
                  <div className="account-main">
                    <div className="account-label">
                      {account.label}
                      <span className="tag">{PROVIDER_SHORT[account.provider] ?? account.provider}</span>
                      {credential ? (
                        <span
                          className="tag login-id"
                          title={`本账号由以下凭据登录：${
                            credential.displayName
                              ? `${credential.displayName}（${credential.username}）`
                              : credential.username
                          }`}
                        >
                          登录账号 {credential.displayName || credential.username}
                        </span>
                      ) : (
                        <span className="tag muted" title="本次登录未关联已保存的凭据">
                          未关联凭据
                        </span>
                      )}
                      {/* 正在签到时把状态就地打在账号名后，不必再让用户满屏找 */}
                      {checking && (
                        <span className="tag checking">
                          <RefreshCw size={11} className="rotating" />
                          签到中…
                        </span>
                      )}
                    </div>
                    <div className="account-meta">
                      {/* 金额只要还有值就展示：刷新失败不代表数字被清空，
                          主进程会保留上一次成功的数据，这里按「是否有数字」上色即可 */}
                      <span className="stat">
                        可用{' '}
                        <b className={status?.available !== undefined ? 'amount ok' : undefined}>
                          {money(status?.available)}
                        </b>
                      </span>
                      <span className="stat">
                        累计{' '}
                        <b className={status?.used !== undefined ? 'amount used' : undefined}>
                          {money(status?.used)}
                        </b>
                      </span>
                      <span className="stat" title={checkin.hint}>
                        签到{' '}
                        <b className={checkin.stale ? 'amount muted' : checkin.reward ? 'amount ok' : undefined}>
                          {checkin.label}
                        </b>
                        {/* 跨天后奖励属于上一次，不再展示成今天的收入 */}
                        {!checkin.stale && checkin.reward ? (
                          <b className="amount ok"> +${checkin.reward.toFixed(2)}</b>
                        ) : null}
                      </span>
                      <span className="stat">刷新 {timeAgo(status?.at)}</span>
                      {/* Key 数量就地显示，点开看详情；不确定时不显示数字 */}
                      {(() => {
                        const kl = keyLists[account.id]
                        if (!kl) {
                          return (
                            <button
                              className="stat key-toggle"
                              onClick={() => void toggleKeys(account.id)}
                              title="查看该账号在站点上的 API Key"
                            >
                              <KeyRound size={11} />
                              Key
                            </button>
                          )
                        }
                        if (kl.loading) {
                          return (
                            <span className="stat key-toggle">
                              <RefreshCw size={11} className="rotating" />
                              读取中
                            </span>
                          )
                        }
                        return (
                          <button
                            className="stat key-toggle active"
                            onClick={() => void toggleKeys(account.id)}
                            title="收起 Key 列表"
                          >
                            <KeyRound size={11} />
                            Key {kl.keys.length > 0 ? kl.keys.length : ''}
                          </button>
                        )
                      })()}
                      {status && !status.ok && (
                        <span
                          className="tag err"
                          title={status.error ?? '刷新失败'}
                        >
                          {describeStatusError(status)}
                        </span>
                      )}
                    </div>

                    {/* Key 详情：key 原文（站点可能已脱敏）+ 分组 + 额度状态 */}
                    {keyLists[account.id] && !keyLists[account.id].loading && (
                      <div className="key-panel">
                        {keyLists[account.id].error ? (
                          <div className="key-error">{keyLists[account.id].error}</div>
                        ) : keyLists[account.id].keys.length === 0 ? (
                          <div className="key-error">该账号在站点上还没有创建 API Key。</div>
                        ) : (
                          keyLists[account.id].keys.map((k) => (
                            <div className="key-row" key={k.id}>
                              <span className="key-name">{k.name}</span>
                              <span className={k.status ? 'tag ok' : 'tag muted'}>
                                {k.status ? '启用' : '已禁用'}
                              </span>
                              <span className={k.group ? 'tag accent' : 'tag muted'}>
                                分组 {k.group || '默认'}
                              </span>
                              <span className="key-value" title={k.key || '站点未返回 key'}>
                                {k.key || '（站点未返回 key）'}
                              </span>
                              <span className="stat">
                                {k.unlimitedQuota
                                  ? '不限额度'
                                  : `剩余 ${money(k.remainQuota !== undefined ? k.remainQuota : undefined)}`}
                              </span>
                              {k.expiredTime === -1 && <span className="stat">永不过期</span>}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <div className="account-actions">
                    {/* 会话已失效时，「重新授权」比「刷新额度」更该被看到 */}
                    {status && !status.ok && isSessionExpired(status.error) && (
                      <button
                        className="btn small primary"
                        onClick={() => props.onReauth(site.id, account.id)}
                        disabled={props.busy.has(`reauth:${account.id}`)}
                        title={`用 ${site.name} 的登录窗口重新授权此账号`}
                      >
                        {props.busy.has(`reauth:${account.id}`) ? (
                          <RefreshCw size={12} className="rotating" />
                        ) : (
                          <LogIn size={12} />
                        )}
                        {props.busy.has(`reauth:${account.id}`) ? '授权中' : '重新授权'}
                      </button>
                    )}
                    <button
                      className="btn small"
                      onClick={() => props.onRefreshAccount(account.id)}
                      disabled={refreshing}
                      title="刷新额度"
                    >
                      <RefreshCw size={12} className={refreshing ? 'rotating' : undefined} />
                      {refreshing ? '刷新中' : '刷新额度'}
                    </button>
                    <button
                      className="btn small primary"
                      onClick={() => props.onCheckin(account.id)}
                      disabled={checking}
                      title={checkinLabel(site.mode)}
                    >
                      {checking ? (
                        <RefreshCw size={12} className="rotating" />
                      ) : (
                        <CalendarCheck size={13} />
                      )}
                      {checking ? '处理中' : checkinLabel(site.mode)}
                    </button>
                    <button
                      className="icon-btn danger"
                      onClick={() => void confirmRemoveAccount(site, account.id, account.label)}
                      title="移除账号"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )
            })}

            <div className="site-foot">
              <button
                className="btn small"
                onClick={() => props.onLogin(site.id)}
                disabled={props.busy.has(`login:${site.id}`)}
              >
                {props.busy.has(`login:${site.id}`) ? (
                  <RefreshCw size={12} className="rotating" />
                ) : (
                  <Plus size={13} />
                )}
                {props.busy.has(`login:${site.id}`) ? '登录中…' : '添加账号'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {editSite && (
        <EditSiteDialog
          site={editSite}
          onClose={() => setEditSite(null)}
          onSubmit={(siteId, patch) => {
            props.onUpdateSite(siteId, patch)
            setEditSite(null)
            props.onToast('站点已更新', 'success')
          }}
        />
      )}
      {dialog}
    </>
  )
}
