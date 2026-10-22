import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { AppInfo, UpdateStatus } from '@shared/ipc'
import type { AppConfig, AuthProvider, LogEntry, Site } from '@shared/types'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { SitesView } from './components/SitesView'
import { SettingsView } from './components/SettingsView'
import { LogsView } from './components/LogsView'
import { CredentialsView } from './components/CredentialsView'
import { AddSiteDialog } from './components/AddSiteDialog'
import { AddAccountDialog } from './components/AddAccountDialog'
import { ToastHost, useToasts } from './components/Toast'
import { applyTheme, watchSystemTheme } from './lib/theme'
import { sortSites } from './lib/sort'

export type ViewKey = 'sites' | 'credentials' | 'logs' | 'settings'

/**
 * 应用外壳。
 *
 * 状态只有一份（来自主进程的 config），渲染进程不维护第二份真相：
 * 每次变更后主进程返回最新 config，这里直接替换。
 */
export function App(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [view, setView] = useState<ViewKey>('sites')
  /** 当前选中的站点；null 表示「全部站点」。批量操作只作用于选中的站点。 */
  const [activeSiteId, setActiveSiteId] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [loginSite, setLoginSite] = useState<Site | null>(null)
  /** 正在重新授权的账号：选中后复用「添加账号」对话框，但提交时替换原账号会话。 */
  const [reauthTarget, setReauthTarget] = useState<{ siteId: string; accountId: string } | null>(
    null
  )
  /**
   * 正在进行的任务集合。
   *
   * 以前是一个字符串，两个账号同时刷新时后一个会把前一个的状态覆盖掉，
   * 于是「先点的那个」立刻变回空闲、看起来像没执行。用集合后各任务互不干扰。
   */
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set())
  const busy = busyKeys.size > 0 ? [...busyKeys][busyKeys.size - 1] : null

  const beginBusy = useCallback((key: string) => {
    setBusyKeys((prev) => new Set(prev).add(key))
  }, [])

  const endBusy = useCallback((key: string) => {
    setBusyKeys((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])
  /** 批量任务进度：当前处理到第几个、共多少个、正在处理谁。 */
  const [batchProgress, setBatchProgress] = useState<{
    kind: 'checkin' | 'refresh'
    done: number
    total: number
    current: string
  } | null>(null)
  /**
   * 批量任务的停止闸门。
   *
   * 循环体在每处理下一个账号前检查它。用 ref 而不是 state：
   * 点击「停止」时循环正在 await，state 更新不会传进已经闭包住的函数，
   * 只有 ref 能让正在跑的循环立刻看到。
   */
  const stopRef = useRef<{ kind: 'checkin' | 'refresh' } | null>(null)
  const [stoppedKind, setStoppedKind] = useState<'checkin' | 'refresh' | null>(null)
  /**
   * 用函数读写闸门，而不是直接访问 stopRef.current。
   * 直接访问会被 TypeScript 的控制流分析收窄成 null（函数里刚赋过值），
   * 于是循环里的 `stopRef.current?.kind` 被判成 never。
   */
  const stopRequested = useCallback(
    (kind: 'checkin' | 'refresh'): boolean => stopRef.current?.kind === kind,
    []
  )
  const resetStop = useCallback((): void => {
    stopRef.current = null
  }, [])
  const { toasts, showToast, dismiss } = useToasts()

  /**
   * 批量进度里的账号名。
   *
   * 进度条是纯文本，没法塞遮罩块；开启打码时干脆不显示账号名，
   * 只保留站点，避免任何身份信息以文字形式漏出。
   */
  const maskRef = useRef(false)
  maskRef.current = config?.settings.maskAccounts ?? false
  const batchName = useCallback(
    (siteName: string, label: string): string =>
      maskRef.current ? `${siteName} / 已打码账号` : `${siteName} / ${label}`,
    []
  )

  const refresh = useCallback(async () => {
    setConfig(await window.api.config.get())
  }, [])

  const loadLogs = useCallback(async () => {
    setLogs(await window.api.logs.get())
  }, [])

  useEffect(() => {
    void refresh()
    // 后台任务（定时签到、续期）改动账号状态后，界面需要跟上
    return window.api.app.onConfigChanged(() => {
      void refresh()
    })
  }, [refresh])

  useEffect(() => {
    if (view === 'logs') void loadLogs()
  }, [view, loadLogs])

  // 主题：写入 <html data-theme>，跟随系统时监听系统深浅色变化
  const theme = config?.settings.theme ?? 'dark'
  useEffect(() => {
    applyTheme(theme)
    return watchSystemTheme(theme, () => applyTheme(theme))
  }, [theme])

  // 版本与更新状态：标题栏据此显示版本号，有新版本时追加 new 徽标
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    void window.api.app.info().then((info) => {
      setAppInfo(info)
      document.documentElement.dataset.platform = info.platform
    })
    void window.api.update.current().then(setUpdateStatus)
    return window.api.update.onChange(setUpdateStatus)
  }, [])
  const hasUpdate =
    updateStatus.state === 'available' ||
    updateStatus.state === 'ready' ||
    updateStatus.state === 'manual'

  const updateSettings = useCallback(
    async (patch: Parameters<typeof window.api.config.updateSettings>[0]) => {
      setConfig(await window.api.config.updateSettings(patch))
    },
    []
  )

  const addSite = useCallback(
    async (input: { catalogId?: string; name?: string; baseUrl?: string }) => {
      beginBusy('add-site')
      try {
        setConfig(await window.api.config.addSite(input))
        setAddOpen(false)
        showToast('站点已添加', 'success')
      } catch (e) {
        showToast(e instanceof Error ? e.message : '添加失败', 'error')
      } finally {
        endBusy('add-site')
      }
    },
    [showToast, beginBusy, endBusy]
  )

  const removeSite = useCallback(
    async (siteId: string) => {
      setConfig(await window.api.config.removeSite(siteId))
      showToast('站点已移除', 'success')
    },
    [showToast]
  )

  const updateSite = useCallback(
    async (siteId: string, patch: Partial<Site>) => {
      setConfig(await window.api.config.updateSite(siteId, patch))
    },
    []
  )

  const reorderSites = useCallback(async (siteIds: string[]) => {
    setConfig(await window.api.config.reorderSites(siteIds))
  }, [])

  const reorderAccounts = useCallback(
    async (siteId: string, accountIds: string[]) => {
      setConfig(await window.api.account.reorder(siteId, accountIds))
    },
    []
  )

  /** 一次恢复所有隐藏的站点。 */
  const showAllHidden = useCallback(async () => {
    const hidden = (config?.sites ?? []).filter((s) => s.hidden)
    if (hidden.length === 0) return
    let latest: AppConfig | null = null
    for (const s of hidden) {
      latest = await window.api.config.updateSite(s.id, { hidden: false })
    }
    if (latest) setConfig(latest)
    showToast(`已恢复 ${hidden.length} 个隐藏站点`, 'success')
  }, [config, showToast])

  /** 侧栏选中站点：主视图只显示该站点，批量操作也只作用于它。 */
  const handleSelectSite = useCallback((siteId: string | null) => {
    setActiveSiteId(siteId)
    setView('sites')
  }, [])

  const login = useCallback(
    async (siteId: string, provider: AuthProvider, credentialId?: string, reauthAccountId?: string) => {
      const key = reauthAccountId ? `reauth:${reauthAccountId}` : `login:${siteId}`
      beginBusy(key)
      // 两种入口共用一个对话框状态，必须都清掉；只清 loginSite 会让重新授权的弹窗关不掉
      setLoginSite(null)
      setReauthTarget(null)
      try {
        const result = await window.api.account.login(
          siteId,
          provider,
          credentialId,
          reauthAccountId
        )
        await refresh()
        if (result.ok) {
          showToast(
            reauthAccountId
              ? result.account?.provider === 'password'
                ? '已重新登录，会话已更新'
                : '已重新授权，会话已更新'
              : `已登录${result.account ? `：${maskRef.current ? '账号已打码' : result.account.label}` : ''}`,
            'success'
          )
        } else {
          showToast(result.error ?? '登录失败', 'error')
        }
      } finally {
        endBusy(key)
      }
    },
    [refresh, showToast, beginBusy, endBusy]
  )

  const refreshAccount = useCallback(
    async (accountId: string) => {
      const key = `status:${accountId}`
      beginBusy(key)
      try {
        const r = await window.api.account.status(accountId)
        await refresh()
        if (r.ok) {
          showToast(`可用额度 $${(r.available ?? 0).toFixed(2)}`, 'success')
        } else {
          showToast(`刷新失败：${r.error ?? '未知错误'}`, 'error')
        }
      } finally {
        endBusy(key)
      }
    },
    [refresh, showToast, beginBusy, endBusy]
  )

  /**
   * 手动签到：行内「签到 / 重登领取」点一次就真的执行一次。
   *
   * 传 force=true 是刻意的：重登类站点（AgentRouter 等）本来就靠「登出再重登」
   * 领取，如果因为「本地回执说今天已签」就把请求拦下来，按钮等于失效。
   * 「今天已签就跳过」只用于批量与定时任务（见 checkinAll 的循环）。
   */
  const checkin = useCallback(
    async (accountId: string) => {
      const key = `checkin:${accountId}`
      beginBusy(key)
      try {
        const r = await window.api.account.checkin(accountId, true)
        await refresh()
        showToast(r.message, r.ok ? 'success' : 'error')
      } finally {
        endBusy(key)
      }
    },
    [refresh, showToast, beginBusy, endBusy]
  )

  /**
   * 当前批量操作的范围。
   *
   * 侧栏选中单个站点时只处理该站点，选「全部站点」才是所有站点。
   * 否则用户在 AgentRouter 页点「全部签到」，却把其它站点也签了，很容易误操作。
   */
  const scopeSites = useMemo(() => {
    const all = config?.sites ?? []
    if (!activeSiteId) return all
    return all.filter((s) => s.id === activeSiteId)
  }, [config, activeSiteId])

  /**
   * 批量签到：逐个账号串行执行，以便界面标出「正在签到哪一个」。
   *
   * 主进程的 checkinAll 是一次性调用，中途没有任何进度回报，
   * 用户只能看到一个转圈的按钮、完全摸黑。这里改成在渲染层循环，
   * 每开始一个账号就更新 busy 标记，进度自然显示在对应的账号行上。
   */
  const checkinAll = useCallback(async () => {
    // 只处理当前选中范围内的站点（侧栏选中单站时就是那一个）
    const targets = scopeSites.flatMap((site) =>
      site.accounts.map((account) => ({ siteId: site.id, siteName: site.name, account }))
    )
    if (targets.length === 0) return

    beginBusy('checkin-all')
    resetStop()
    setStoppedKind(null)
    setBatchProgress({ kind: 'checkin', done: 0, total: targets.length, current: '' })
    let ok = 0
    let skipped = 0
    let handled = 0
    try {
      for (let i = 0; i < targets.length; i++) {
        // 用户点了「停止」：当前这个跑完就收工，不再开新的
        if (stopRequested('checkin')) break
        const t = targets[i]
        setBatchProgress({
          kind: 'checkin',
          done: i,
          total: targets.length,
          current: batchName(t.siteName, t.account.label)
        })
        // 让该行也能显示自己的处理中状态
        beginBusy(`checkin:${t.account.id}`)
        try {
          const r = await window.api.account.checkin(t.account.id)
          if (r.ok) ok++
          if (r.ok && r.already) skipped++
        } catch {
          // 单个账号失败不打断整批
        }
        endBusy(`checkin:${t.account.id}`)
        handled = i + 1
        // 与额度刷新一致：处理完一个就前进一格，最后一个结束时到 100%
        setBatchProgress({
          kind: 'checkin',
          done: i + 1,
          total: targets.length,
          current: batchName(t.siteName, t.account.label)
        })
        await refresh()
      }
      const stopped = handled < targets.length
      const done = `成功 ${ok} / ${targets.length}${
        skipped > 0 ? `（其中 ${skipped} 个今日已签，自动跳过）` : ''
      }`
      showToast(
        stopped
          ? `已停止签到：处理 ${handled} / ${targets.length}，${done}`
          : `${
              activeSiteId ? scopeSites[0]?.name ?? '当前站点' : '全部站点'
            }签到完成：${done}`,
        stopped || ok !== handled ? 'info' : 'success'
      )
    } finally {
      endBusy('checkin-all')
      resetStop()
      setBatchProgress(null)
      setStoppedKind(null)
      await refresh()
    }
  }, [scopeSites, activeSiteId, refresh, showToast, beginBusy, endBusy, batchName])

  /**
   * 刷新额度：和批量签到一样逐账号串行，并把进度显示出来。
   *
   * 之前这里只有一个转圈的总按钮，18 个账号要等半分钟以上，
   * 完全看不出进度、也不知道卡在哪个账号。现在每个账号开始刷新时
   * 同时点亮该行的「刷新中」标记，顶部进度条同步推进。
   */
  const refreshAll = useCallback(async () => {
    const targets = scopeSites.flatMap((site) =>
      site.accounts.map((account) => ({ siteId: site.id, siteName: site.name, account }))
    )
    if (targets.length === 0) return

    beginBusy('refresh-all')
    resetStop()
    setStoppedKind(null)
    setBatchProgress({ kind: 'refresh', done: 0, total: targets.length, current: '' })
    let ok = 0
    let handled = 0
    try {
      for (let i = 0; i < targets.length; i++) {
        // 单个账号可能要等 20 秒超时，没有停止入口时用户只能干等
        if (stopRequested('refresh')) break
        const t = targets[i]
        setBatchProgress({
          kind: 'refresh',
          done: i,
          total: targets.length,
          current: batchName(t.siteName, t.account.label)
        })
        beginBusy(`status:${t.account.id}`)
        try {
          const r = await window.api.account.status(t.account.id)
          if (r.ok) ok++
        } catch {
          // 单个账号失败不打断整批
        }
        endBusy(`status:${t.account.id}`)
        handled = i + 1
        // 让进度条在处理完一个账号后就前进一格，最后一个账号结束时到 100%
        setBatchProgress({
          kind: 'refresh',
          done: i + 1,
          total: targets.length,
          current: batchName(t.siteName, t.account.label)
        })
        await refresh()
      }
      const stopped = handled < targets.length
      showToast(
        stopped
          ? `已停止刷新：处理 ${handled} / ${targets.length}，成功 ${ok}`
          : `额度已刷新：成功 ${ok} / ${targets.length}`,
        !stopped && ok === targets.length ? 'success' : 'info'
      )
    } finally {
      endBusy('refresh-all')
      resetStop()
      setBatchProgress(null)
      setStoppedKind(null)
      await refresh()
    }
  }, [scopeSites, refresh, showToast, beginBusy, endBusy, batchName])

  /**
   * 停止批量任务。
   *
   * 只改闸门标记，不中断正在进行的那个请求：正在跑的签到可能已经发出去了，
   * 强行取消会让「发了请求但没读回执」的状态落到本地，反而更乱。
   * 因此当前账号处理完就停，进度文案会说明实际处理了几个。
   */
  const stopBatch = useCallback(() => {
    if (!batchProgress) return
    stopRef.current = { kind: batchProgress.kind }
    setStoppedKind(batchProgress.kind)
  }, [batchProgress])

  const removeAccount = useCallback(
    async (accountId: string) => {
      setConfig(await window.api.account.remove(accountId))
      showToast('账号已移除', 'success')
    },
    [showToast]
  )

  const hiddenSites = useMemo(
    () => new Set((config?.sites ?? []).filter((s) => s.hidden).map((s) => s.id)),
    [config]
  )

  const sidebarSites = useMemo(() => {
    const filtered = (config?.sites ?? []).filter(
      (s) => !(config?.settings.hideHiddenSites && hiddenSites.has(s.id))
    )
    return sortSites(
      filtered,
      config?.settings.siteSort ?? 'custom',
      config?.settings.siteSortDir ?? 'desc'
    )
  }, [config, hiddenSites])

  const visibleSites = useMemo(() => {
    const filtered = scopeSites.filter(
      (s) => !(config?.settings.hideHiddenSites && hiddenSites.has(s.id))
    )
    // 主视图只用「当前范围」内的站点
    return sortSites(
      filtered,
      config?.settings.siteSort ?? 'custom',
      config?.settings.siteSortDir ?? 'desc'
    )
  }, [scopeSites, config, hiddenSites])

  /** 选中的站点被移除或隐藏后，回到「全部站点」，避免主视图空白。 */
  useEffect(() => {
    if (!activeSiteId) return
    const stillVisible = sidebarSites.some((s) => s.id === activeSiteId)
    if (!stillVisible) setActiveSiteId(null)
  }, [activeSiteId, sidebarSites])

  /** 切换排序：金额类默认从高到低，名称默认从 A 到 Z。 */
  if (!config) {
    return (
      <div className="app-frame">
        <TitleBar collapsed={false} hasUpdate={false} />
        <div className="app-loading">
          <LoaderCircle size={30} className="rotating" />
          <div>正在加载…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-frame">
      <TitleBar
        collapsed={config.settings.sidebarCollapsed}
        version={appInfo?.version}
        hasUpdate={hasUpdate}
      />
      <div className="shell">
      <Sidebar
        sites={config.sites}
        visibleSites={sidebarSites}
        settings={config.settings}
        view={view}
        onViewChange={setView}
        activeSiteId={activeSiteId}
        onSelectSite={handleSelectSite}
        onToggleCollapse={() =>
          void updateSettings({ sidebarCollapsed: !config.settings.sidebarCollapsed })
        }
        onToggleSiteHidden={(siteId, hidden) => void updateSite(siteId, { hidden })}
        onShowAllHidden={() => void showAllHidden()}
        onAddSite={() => setAddOpen(true)}
      />

      <div className="main">
        {view === 'sites' && (
          <SitesView
            sites={visibleSites}
            allSites={config.sites}
            credentials={config.credentials.map((c) => ({
              id: c.id,
              provider: c.provider,
              username: c.username,
              displayName: c.displayName,
              note: c.note,
              hasPassword: !!c.password,
              hasTotp: !!c.totpSecret,
              lastUsedAt: c.lastUsedAt,
              createdAt: c.createdAt
            }))}
            busy={busyKeys}
            batchProgress={batchProgress}
            stopping={stoppedKind !== null}
            onStopBatch={stopBatch}
            activeSiteId={activeSiteId}
            siteSort={config.settings.siteSort}
            siteSortDir={config.settings.siteSortDir}
            accountSort={config.settings.accountSort}
            accountSortDir={config.settings.accountSortDir}
            maskAccounts={config.settings.maskAccounts}
            onToggleMask={() =>
              void updateSettings({ maskAccounts: !config.settings.maskAccounts })
            }
            onAccountSortChange={(sort, dir) =>
              void updateSettings({ accountSort: sort, accountSortDir: dir })
            }
            onAddSite={() => setAddOpen(true)}
            onLogin={(siteId) => {
              const target = config.sites.find((s) => s.id === siteId)
              if (target) setLoginSite(target)
            }}
            onReauth={(siteId, accountId) => setReauthTarget({ siteId, accountId })}
            onRefreshAccount={refreshAccount}
            onCheckin={checkin}
            onRemoveAccount={removeAccount}
            onRemoveSite={removeSite}
            onUpdateSite={updateSite}
            onCheckinAll={checkinAll}
            onReorderSites={reorderSites}
            onReorderAccounts={reorderAccounts}
            onRefreshAll={refreshAll}
            onToast={showToast}
          />
        )}
        {view === 'credentials' && (
          <CredentialsView
            onToast={showToast}
            onChanged={refresh}
            maskAccounts={config.settings.maskAccounts}
          />
        )}
        {view === 'logs' && <LogsView logs={logs} sites={config.sites} maskAccounts={config.settings.maskAccounts} onReload={loadLogs} onClear={async () => {
          await window.api.logs.clear()
          await loadLogs()
          showToast('日志已清空', 'success')
        }} />}
        {view === 'settings' && (
          <SettingsView
            settings={config.settings}
            onChange={updateSettings}
            onToast={showToast}
          />
        )}
      </div>

      {addOpen && (
        <AddSiteDialog
          existingSiteIds={config.sites.map((s) => s.id)}
          busy={busy === 'add-site'}
          onClose={() => setAddOpen(false)}
          onSubmit={addSite}
        />
      )}
      {loginSite && (
        <AddAccountDialog
          site={loginSite}
          onClose={() => setLoginSite(null)}
          onSubmit={login}
        />
      )}
      {reauthTarget && (() => {
        const site = config.sites.find((s) => s.id === reauthTarget.siteId)
        if (!site) return null
        return (
          <AddAccountDialog
            site={site}
            reauthAccountId={reauthTarget.accountId}
            onClose={() => setReauthTarget(null)}
            onSubmit={login}
          />
        )
      })()}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
      </div>
    </div>
  )
}
