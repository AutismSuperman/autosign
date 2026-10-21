import { useEffect, useMemo, useState } from 'react'
import { Copy, KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react'
import type { AuthProvider, PublicCredential } from '@shared/types'
import { Modal } from './Modal'
import { MaskedText } from './MaskedText'
import { Select } from './Select'
import { Seg } from './Seg'
import { useConfirm } from './ConfirmDialog'
import type { ToastKind } from './Toast'
import { copyText } from '../lib/clipboard'
import { providerAvatar, providerLabel, timeAgo } from '../lib/format'

interface Props {
  onToast: (message: string, kind?: ToastKind) => void
  /** 凭据数量变化时通知外层刷新（站点卡片要用它显示可选身份）。 */
  onChanged?: () => void
  /** 账号打码：开启后用户名等身份信息以掩码显示。 */
  maskAccounts?: boolean
}

/** 筛选维度：登录方式与密码/TOTP 是否已保存。 */
type ProviderFilter = AuthProvider | 'all'
type FeatureFilter = 'all' | 'password' | 'totp' | 'no-totp'

const PROVIDER_FILTERS: Array<{ key: ProviderFilter; label: string }> = [
  { key: 'all', label: '全部方式' },
  { key: 'github', label: 'GitHub' },
  { key: 'linuxdo', label: 'Linux DO' },
  { key: 'password', label: '邮箱 / 密码' }
]

const FEATURE_FILTERS: Array<{ key: FeatureFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'password', label: '已存密码' },
  { key: 'totp', label: '有两步验证' },
  { key: 'no-totp', label: '无两步验证' }
]

interface Draft {
  id?: string
  provider: AuthProvider
  username: string
  displayName: string
  password: string
  totpSecret: string
  note: string
}

const EMPTY: Draft = {
  provider: 'github',
  username: '',
  displayName: '',
  password: '',
  totpSecret: '',
  note: ''
}

/**
 * 账号维护页。
 *
 * 这里维护的是「能用来登录的身份」：用户名、密码、TOTP 密钥。
 * 与站点上的会话（账号）分开 —— 一份凭据可以授权多个站点，
 * 添加账号时选中它即可自动填表，不必每次手输。
 *
 * 密码与 TOTP 一旦保存就无法再读出（只显示「已保存」），
 * 这与系统密钥加密的语义一致：加密后只有主进程能解开，界面拿不到原文。
 */
export function CredentialsView({ onToast, onChanged, maskAccounts }: Props): React.JSX.Element {
  const [list, setList] = useState<PublicCredential[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [otpPreview, setOtpPreview] = useState<{ otp: string; remaining: number } | null>(null)
  const [testError, setTestError] = useState('')
  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all')
  const [featureFilter, setFeatureFilter] = useState<FeatureFilter>('all')
  const { confirm, dialog } = useConfirm()

  /** 检索 + 筛选。检索覆盖显示名称、用户名、备注，任一命中即保留。 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter((c) => {
      if (providerFilter !== 'all' && c.provider !== providerFilter) return false
      if (featureFilter === 'password' && !c.hasPassword) return false
      if (featureFilter === 'totp' && !c.hasTotp) return false
      if (featureFilter === 'no-totp' && c.hasTotp) return false
      if (!q) return true
      return (
        (c.displayName ?? '').toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q) ||
        (c.note ?? '').toLowerCase().includes(q)
      )
    })
  }, [list, query, providerFilter, featureFilter])

  const hasFilter = query.trim() !== '' || providerFilter !== 'all' || featureFilter !== 'all'

  const resetFilters = (): void => {
    setQuery('')
    setProviderFilter('all')
    setFeatureFilter('all')
  }

  const reload = async (): Promise<void> => {
    setList(await window.api.credential.list())
    onChanged?.()
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openNew = (): void => {
    setDraft({ ...EMPTY })
    setOtpPreview(null)
    setTestError('')
  }

  const openEdit = (c: PublicCredential): void => {
    setDraft({
      id: c.id,
      provider: c.provider,
      username: c.username,
      displayName: c.displayName ?? '',
      password: '',
      totpSecret: '',
      note: c.note ?? ''
    })
    setOtpPreview(null)
    setTestError('')
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      setList(
        await window.api.credential.save({
          id: draft.id,
          provider: draft.provider,
          username: draft.username,
          displayName: draft.displayName || undefined,
          password: draft.password || undefined,
          totpSecret: draft.totpSecret || undefined,
          note: draft.note || undefined
        })
      )
      onChanged?.()
      setDraft(null)
      onToast(draft.id ? '凭据已更新' : '凭据已保存', 'success')
    } catch (e) {
      onToast(e instanceof Error ? e.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const confirmRemove = async (c: PublicCredential): Promise<void> => {
    const ok = await confirm({
      title: '删除凭据？',
      danger: true,
      confirmLabel: '删除',
      message: (
        <>
          将删除凭据{' '}
          <b>
            {maskAccounts ? (
              <MaskedText value={c.displayName || c.username} size="sm" />
            ) : (
              c.displayName || c.username
            )}
          </b>
          （{providerLabel(c.provider)}）。
          已登录的站点会话不受影响，但之后无法再用它自动登录。
        </>
      )
    })
    if (!ok) return
    setList(await window.api.credential.remove(c.id))
    onChanged?.()
    // toast 走打码后的简短描述：不打码时给名字，打码时只给方式，避免从提示里漏出原文
    onToast(
      maskAccounts ? '凭据已删除' : `已删除 ${c.displayName || c.username}`,
      'success'
    )
  }

  const copy = async (text: string, what: string): Promise<void> => {
    const ok = await copyText(text)
    onToast(ok ? `${what}已复制` : '复制失败', ok ? 'success' : 'error')
  }

  const testTotp = async (): Promise<void> => {
    if (!draft?.totpSecret) {
      setTestError('请先填写 TOTP 密钥')
      return
    }
    const r = await window.api.credential.test({ totpSecret: draft.totpSecret })
    if (!r.ok) {
      setTestError(r.error ?? '校验失败')
      setOtpPreview(null)
      return
    }
    setTestError('')
    setOtpPreview({ otp: r.otp ?? '', remaining: r.remaining ?? 30 })
  }

  const saveDisabled =
    !draft ||
    saving ||
    !draft.username.trim() ||
    // 新建密码凭据时必须填密码，否则保存下来也用不了
    (draft.provider === 'password' && !draft.id && !draft.password)

  return (
    <>
      <div className="topbar">
        <span className="topbar-icon">
          <KeyRound size={16} />
        </span>
        <h1>账号</h1>
        <span className="sub">用于自动登录的身份凭据</span>
        <span className="spacer" />
        <button className="btn primary" onClick={openNew}>
          <Plus size={14} />
          添加凭据
        </button>
      </div>

      <div className="content">
        <div className="log-toolbar">
          <div className="search-box">
            <Search size={14} />
            <input
              placeholder="检索显示名称、用户名或备注…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="检索凭据"
            />
          </div>
          <Select
            value={providerFilter}
            options={PROVIDER_FILTERS.map((f) => ({ value: f.key, label: f.label }))}
            onChange={setProviderFilter}
            title="按登录方式筛选"
            ariaLabel="按登录方式筛选"
          />
          <Select
            value={featureFilter}
            options={FEATURE_FILTERS.map((f) => ({ value: f.key, label: f.label }))}
            onChange={setFeatureFilter}
            title="按已保存的登录要素筛选"
            ariaLabel="按登录要素筛选"
          />
          {hasFilter && (
            <span className="stat">
              {filtered.length} / {list.length}
            </span>
          )}
          {hasFilter && (
            <button className="btn small" onClick={resetFilters}>
              重置
            </button>
          )}
        </div>

        <div className="panel">
          <div className="cred-list">
            {list.length === 0 && (
              <div className="cred-empty">
                <KeyRound size={36} strokeWidth={1.4} className="empty-icon" />
                <div>
                  还没有保存任何凭据。添加后，在站点上「添加账号」时可以直接选用，
                  登录页会自动填好用户名、密码与两步验证码。
                </div>
                <button className="btn primary small" onClick={openNew}>
                  <Plus size={13} />
                  添加凭据
                </button>
              </div>
            )}
            {list.length > 0 && filtered.length === 0 && (
              <div className="cred-empty">
                <Search size={36} strokeWidth={1.4} className="empty-icon" />
                <div>没有匹配的凭据，调整检索或筛选条件试试。</div>
                <button className="btn small" onClick={resetFilters}>
                  重置条件
                </button>
              </div>
            )}
            {filtered.map((c) => (
              <div className="cred-row" key={c.id}>
                <div className="cred-avatar">{providerAvatar(c.provider)}</div>
                <div className="cred-main">
                  <div className="cred-name">
                    <span className="cred-name-row">
                      {maskAccounts ? (
                        <MaskedText value={c.displayName || c.username} />
                      ) : (
                        c.displayName || c.username
                      )}
                      <button
                        className="icon-btn tiny"
                        onClick={() => void copy(c.username, '用户名')}
                        title={maskAccounts ? '复制用户名（仍复制真实值）' : '复制用户名'}
                      >
                        <Copy size={12} />
                      </button>
                    </span>
                    <span className="tag">{providerLabel(c.provider)}</span>
                    {/* 显示名称与登录用户名不同时，把用户名也标出来，避免认错身份 */}
                    {c.displayName && (
                      <span className="cred-username">
                        {maskAccounts ? <MaskedText value={c.username} size="sm" /> : c.username}
                      </span>
                    )}
                    {c.note && <span className="cred-note">{c.note}</span>}
                  </div>
                  <div className="cred-meta">
                    <span className={c.hasPassword ? 'tag ok' : 'tag'}>
                      {c.hasPassword ? '已存密码' : '未存密码'}
                    </span>
                    <span className={c.hasTotp ? 'tag ok' : 'tag'}>
                      {c.hasTotp ? '已存两步验证' : '无两步验证'}
                    </span>
                    <span className="stat">
                      {c.lastUsedAt ? timeAgo(c.lastUsedAt) : '未使用'}
                    </span>
                  </div>
                </div>
                <div className="cred-actions">
                  <button className="icon-btn" onClick={() => openEdit(c)} title="编辑凭据">
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn danger"
                    onClick={() => void confirmRemove(c)}
                    title="删除凭据"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="hint hint-inline">
          <ShieldCheck size={14} />
          <span>
            密码与两步验证密钥经系统密钥加密后落盘，保存后无法再读出；
            界面只显示是否已保存。凭据仅在本机使用，不会上传。
          </span>
        </div>
      </div>

      {draft && (
        <Modal
          title={draft.id ? '编辑凭据' : '添加凭据'}
          onClose={() => setDraft(null)}
          onSubmit={() => void save()}
          submitDisabled={!!saveDisabled}
        >
          <div className="modal-field">
            <label className="modal-label">登录方式</label>
            <Seg
              value={draft.provider}
              items={(['github', 'linuxdo', 'password'] as AuthProvider[]).map((p) => ({
                key: p,
                label: providerLabel(p)
              }))}
              onChange={(p) => setDraft({ ...draft, provider: p })}
              ariaLabel="登录方式"
            />
          </div>

          <div className="modal-field">
            <label className="modal-label">
              显示名称
              <span className="modal-label-hint">（可选，留空则显示用户名）</span>
            </label>
            <input
              value={draft.displayName}
              placeholder="例如：主力号 / 小号"
              onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            />
          </div>

          <div className="modal-field">
            <label className="modal-label">
              {draft.provider === 'password' ? '用户名 / 邮箱' : '用户名'}
            </label>
            <input
              value={draft.username}
              placeholder={
                draft.provider === 'github'
                  ? 'GitHub 用户名或邮箱'
                  : draft.provider === 'linuxdo'
                    ? 'Linux DO 用户名'
                    : '站点的用户名或注册邮箱'
              }
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
            />
          </div>

          <div className="modal-field">
            <label className="modal-label">
              密码
              {draft.id && <span className="modal-label-hint">（留空表示不修改）</span>}
              {draft.provider === 'password' && !draft.id && (
                <span className="modal-label-hint">（必填）</span>
              )}
            </label>
            <input
              type="password"
              value={draft.password}
              placeholder={draft.id ? '保持不变' : '登录密码'}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
            {draft.provider === 'password' && (
              <div className="hint">
                邮箱/密码登录直接调用站点登录接口，密码会加密保存。
              </div>
            )}
          </div>

          <div className="modal-field">
            <label className="modal-label">
              两步验证密钥
              <span className="modal-label-hint">（TOTP，可选）</span>
            </label>
            <div className="field-row">
              <input
                className="input-flex"
                value={draft.totpSecret}
                placeholder={draft.id ? '保持不变' : 'Base32 密钥，例如 JBSWY3DPEHPK3PXP'}
                onChange={(e) => setDraft({ ...draft, totpSecret: e.target.value })}
              />
              <button className="btn small" onClick={() => void testTotp()}>
                <ShieldCheck size={13} />
                校验
              </button>
            </div>
            {otpPreview && (
              <div className="otp-preview">
                当前验证码 <b className="tabular">{otpPreview.otp}</b>
                <span className="stat">剩余 {otpPreview.remaining}s</span>
                <button
                  className="icon-btn tiny"
                  onClick={() => void copy(otpPreview.otp, '验证码')}
                  title="复制验证码"
                >
                  <Copy size={12} />
                </button>
              </div>
            )}
            {testError && <div className="modal-error">{testError}</div>}
          </div>

          <div className="modal-field">
            <label className="modal-label">
              备注
              <span className="modal-label-hint">（可选）</span>
            </label>
            <input
              value={draft.note}
              placeholder="例如：小号 / 主力账号"
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </div>

          <div className="modal-actions">
            <button className="btn" onClick={() => setDraft(null)}>
              取消
            </button>
            <button className="btn primary" disabled={!!saveDisabled} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </Modal>
      )}
      {dialog}
    </>
  )
}
