import { useMemo, useState } from 'react'
import { Check, Plus, Search, ServerCog } from 'lucide-react'
import { CATALOG } from '@shared/catalog'
import type { CatalogEntry } from '@shared/types'
import { Modal } from './Modal'
import { Seg } from './Seg'
import { MODE_LABEL, providerLabel } from '../lib/format'
import { useSiteIcon } from '../lib/useSiteIcon'

interface Props {
  existingSiteIds: string[]
  busy: boolean
  onClose: () => void
  onSubmit: (input: { catalogId?: string; name?: string; baseUrl?: string }) => void
}

/** 目录卡片头像：优先站点 logo，抓不到回退首字母。 */
function CatalogAvatar({ name, baseUrl }: { name: string; baseUrl: string }): React.JSX.Element {
  const icon = useSiteIcon(baseUrl)
  if (icon) {
    return (
      <span className="catalog-avatar has-logo">
        <img src={icon} alt="" aria-hidden="true" />
      </span>
    )
  }
  return <span className="catalog-avatar">{name.slice(0, 1).toUpperCase()}</span>
}

/**
 * 添加站点。
 *
 * 内置站点以卡片网格呈现：一眼能看到站点名、域名、登录方式与签到方式，
 * 点卡片即选中（双击直接添加），自定义站点保留表单，
 * 添加时会读 /api/status 自动识别协议形态。
 */
export function AddSiteDialog(props: Props): React.JSX.Element {
  const [tab, setTab] = useState<'catalog' | 'custom'>('catalog')
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return CATALOG.filter((c) => {
      if (props.existingSiteIds.includes(c.id)) return false
      if (!q) return true
      return (
        c.name.toLowerCase().includes(q) ||
        c.baseUrl.toLowerCase().includes(q) ||
        c.note.toLowerCase().includes(q)
      )
    })
  }, [query, props.existingSiteIds])

  const allAdded = CATALOG.every((c) => props.existingSiteIds.includes(c.id))
  const canSubmitCustom = name.trim().length > 0 && /^https?:\/\//i.test(baseUrl.trim())
  const canSubmit = props.busy ? false : tab === 'catalog' ? !!selected : canSubmitCustom

  const submit = (): void => {
    if (!canSubmit) return
    props.onSubmit(
      tab === 'catalog'
        ? { catalogId: selected }
        : { name: name.trim(), baseUrl: baseUrl.trim() }
    )
  }

  return (
    <Modal
      title="添加站点"
      wide
      onClose={props.onClose}
      onSubmit={submit}
      submitDisabled={!canSubmit}
      headExtra={
        <Seg
          value={tab}
          items={[
            { key: 'catalog', label: '内置站点', icon: ServerCog },
            { key: 'custom', label: '自定义', icon: Plus }
          ]}
          onChange={setTab}
          ariaLabel="添加方式"
        />
      }
    >
      {tab === 'catalog' ? (
        <>
          <div className="search-box catalog-search">
            <Search size={14} />
            <input
              placeholder="搜索站点、域名或说明…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {items.length === 0 ? (
            <div className="catalog-empty">
              <ServerCog size={30} strokeWidth={1.4} className="empty-icon" />
              {allAdded ? '内置站点已全部添加。' : '没有匹配的站点，换个关键词试试。'}
            </div>
          ) : (
            <div className="catalog-grid">
              {items.map((c: CatalogEntry) => (
                <button
                  key={c.id}
                  className={selected === c.id ? 'catalog-card selected' : 'catalog-card'}
                  onClick={() => setSelected(c.id)}
                  onDoubleClick={() => props.onSubmit({ catalogId: c.id })}
                >
                  <div className="catalog-card-head">
                    <CatalogAvatar name={c.name} baseUrl={c.baseUrl} />
                    <span className="catalog-name">{c.name}</span>
                    {selected === c.id && (
                      <span className="catalog-check">
                        <Check size={15} />
                      </span>
                    )}
                  </div>
                  <div className="catalog-host">{c.baseUrl.replace(/^https?:\/\//, '')}</div>
                  <div className="catalog-tags">
                    <span className="tag">{MODE_LABEL[c.mode]}</span>
                    <span className="tag">{providerLabel(c.provider)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="modal-field">
            <label className="modal-label">站点名称</label>
            <input
              placeholder="例如 My Relay"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="modal-field">
            <label className="modal-label">站点地址</label>
            <input
              placeholder="https://api.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {baseUrl.trim() !== '' && !/^https?:\/\//i.test(baseUrl.trim()) && (
              <div className="modal-error">地址必须以 http:// 或 https:// 开头</div>
            )}
          </div>
          <div className="hint">
            添加时会读取该站点的 <code>/api/status</code>，自动识别协议形态、
            签到方式与人机验证配置。
          </div>
        </>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          取消
        </button>
        <button className="btn primary" disabled={!canSubmit} onClick={submit}>
          {props.busy ? '处理中…' : '添加'}
        </button>
      </div>
    </Modal>
  )
}
