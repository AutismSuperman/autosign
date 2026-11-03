import {
  EyeOff,
  Globe,
  KeyRound,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScrollText,
  Settings
} from 'lucide-react'
import type { Site } from '@shared/types'
import type { ViewKey } from '../App'
import { useSiteIcon } from '../lib/useSiteIcon'

interface Props {
  /** 全部站点（含从侧栏隐藏的）：用于「全部站点」计数与折叠态回退。 */
  sites: Site[]
  /** 侧栏里要列出的站点（已按可见性过滤并排序）。 */
  visibleSites: Site[]
  settings: { sidebarCollapsed: boolean }
  view: ViewKey
  onViewChange: (v: ViewKey) => void
  /** 当前选中的站点；null 表示「全部站点」。侧栏据此高亮并过滤主视图。 */
  activeSiteId: string | null
  onSelectSite: (siteId: string | null) => void
  onToggleCollapse: () => void
  /** 切换站点是否在侧栏显示。数据与账号完全不受影响。 */
  onToggleSiteHidden: (siteId: string, hidden: boolean) => void
  onAddSite: () => void
}

/** 账号健康度：任一账号额度读取失败即红，未登录即灰。 */
function siteTone(site: Site): 'ok' | 'warn' | 'err' | '' {
  if (site.accounts.length === 0) return ''
  const now = Date.now()
  const failed = site.accounts.some(
    (a) => a.lastStatus && !a.lastStatus.ok && now - a.lastStatus.at < 86_400_000
  )
  if (failed) return 'err'
  const pending = site.accounts.some((a) => !a.lastStatus)
  if (pending) return 'warn'
  return 'ok'
}

/** 侧栏里单个站点的图标：抓到就用站点 logo，抓不到回退地球图标。 */
function SiteIcon({ site }: { site: Site }): React.JSX.Element {
  const icon = useSiteIcon(site.baseUrl)
  if (icon) return <img className="nav-site-icon" src={icon} alt="" aria-hidden="true" />
  return <Globe size={15} />
}

/**
 * 左侧站点菜单。
 *
 * 站点行本身就是「可见性开关」：鼠标悬停时右侧的眼睛图标可以把它从侧栏收起，
 * 再点一次恢复。收起只是**侧栏不显示**，账号、额度、签到与定时任务完全不受影响，
 * 所以它不叫「隐藏」，也没有单独的「显示全部」入口 —— 开关就在原处，不需要去别处找。
 *
 * 另外还有整栏折叠为图标条（collapsed），那是纯布局，与站点可见性无关。
 */
export function Sidebar(props: Props): React.JSX.Element {
  const { settings, view, visibleSites, sites } = props
  const collapsed = settings.sidebarCollapsed

  return (
    <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
      <div className="sidebar-scroll">
        <div className="section-head">
          <span>站点</span>
          <button onClick={props.onAddSite} title="添加站点">
            <Plus size={12} />
            <span>添加</span>
          </button>
        </div>

        <button
          className={view === 'sites' && !props.activeSiteId ? 'nav-item active' : 'nav-item'}
          onClick={() => {
            props.onViewChange('sites')
            props.onSelectSite(null)
          }}
          title="全部站点"
        >
          <span className="nav-icon">
            <LayoutGrid size={16} />
          </span>
          <span className="nav-label">全部站点</span>
          {/*
            计数只算「侧栏可见的站点」，与下面列出的条目数一致。
            显示全部站点数会与列表对不上（3 vs 2），让人以为漏了东西 ——
            用户此刻关心的是「我能点进几个」，而不是数据库里存了几个。
          */}
          {visibleSites.length > 0 && <span className="nav-count">{visibleSites.length}</span>}
        </button>

        {visibleSites.map((site) => {
          const tone = siteTone(site)
          const active = view === 'sites' && props.activeSiteId === site.id
          return (
            <div key={site.id} className="nav-site-row">
              <button
                className={active ? 'nav-item active' : 'nav-item'}
                onClick={() => {
                  props.onViewChange('sites')
                  props.onSelectSite(site.id)
                }}
                title={site.name}
              >
                <span className="nav-icon">
                  <SiteIcon site={site} />
                  {tone && <span className={`nav-dot ${tone}`} />}
                </span>
                <span className="nav-label">{site.name}</span>
                {site.accounts.length > 0 && (
                  <span className="nav-count">{site.accounts.length}</span>
                )}
              </button>
              {/* 悬停才出现，避免平时干扰阅读；键盘聚焦时也可见 */}
              <button
                className="nav-hide-toggle"
                onClick={(e) => {
                  e.stopPropagation()
                  props.onToggleSiteHidden(site.id, true)
                }}
                title={`从侧栏收起「${site.name}」（账号与数据不变）`}
                aria-label={`从侧栏收起 ${site.name}`}
              >
                <EyeOff size={13} />
              </button>
            </div>
          )
        })}

        {visibleSites.length === 0 && !collapsed && (
          <div className="hint sidebar-hint">
            {sites.length > 0
              ? '所有站点都已从侧栏收起，点「全部站点」可查看并恢复。'
              : '还没有站点，点击上方「添加」。'}
          </div>
        )}

        <div className="section-head">
          <span>系统</span>
        </div>

        <button
          className={view === 'credentials' ? 'nav-item active' : 'nav-item'}
          onClick={() => props.onViewChange('credentials')}
          title="账号"
        >
          <span className="nav-icon">
            <KeyRound size={16} />
          </span>
          <span className="nav-label">账号</span>
        </button>
        <button
          className={view === 'logs' ? 'nav-item active' : 'nav-item'}
          onClick={() => props.onViewChange('logs')}
          title="运行日志"
        >
          <span className="nav-icon">
            <ScrollText size={16} />
          </span>
          <span className="nav-label">运行日志</span>
        </button>
        <button
          className={view === 'settings' ? 'nav-item active' : 'nav-item'}
          onClick={() => props.onViewChange('settings')}
          title="设置"
        >
          <span className="nav-icon">
            <Settings size={16} />
          </span>
          <span className="nav-label">设置</span>
        </button>
      </div>

      <div className="sidebar-foot">
        <button
          className="nav-item"
          onClick={props.onToggleCollapse}
          title={collapsed ? '展开侧栏' : '折叠侧栏'}
          aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
        >
          <span className="nav-icon">
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </span>
          <span className="nav-label">{collapsed ? '展开侧栏' : '折叠侧栏'}</span>
        </button>
      </div>
    </aside>
  )
}
