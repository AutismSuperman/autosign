import { useEffect, useState } from 'react'
import { ExternalLink, KeyRound, LogIn } from 'lucide-react'
import type { AuthProvider, PublicCredential, Site } from '@shared/types'
import { Modal } from './Modal'
import { providerAvatar, providerLabel } from '../lib/format'

interface Props {
  site: Site
  /** 重新授权模式：替换该账号的会话，而不是新增。 */
  reauthAccountId?: string
  onClose: () => void
  onSubmit: (
    siteId: string,
    provider: AuthProvider,
    credentialId?: string,
    reauthAccountId?: string
  ) => void
}

/**
 * 添加账号。
 *
 * 三种方式：
 *   - GitHub / Linux DO：打开授权窗口；选了已保存凭据就在后台自动填表
 *   - 邮箱 / 密码：直接调站点 /api/user/login，不打开窗口，必须选一份凭据
 *
 * 站点支持哪些登录方式来自站点探测结果，不写死。
 */
export function AddAccountDialog({
  site,
  reauthAccountId,
  onClose,
  onSubmit
}: Props): React.JSX.Element {
  const reauthAccount = reauthAccountId
    ? site.accounts.find((a) => a.id === reauthAccountId)
    : undefined
  const reauth = !!reauthAccount
  // 密码登录是 New API 系的标准能力，所有 NEWAPI 站点都提供
  const providers: AuthProvider[] =
    site.kind === 'NEWAPI' ? ['github', 'linuxdo', 'password'] : ['github']
  const [provider, setProvider] = useState<AuthProvider>(reauthAccount?.provider ?? site.provider)
  const [credentials, setCredentials] = useState<PublicCredential[]>([])
  const [selected, setSelected] = useState<string>('')

  useEffect(() => {
    void window.api.credential.list().then(setCredentials)
  }, [])

  /**
   * 已经在该站点登录过的凭据不再列出。
   *
   * 同一个身份重复添加只会得到一份重复会话，站点侧还会触发会话数上限；
   * 账号记录里记住了来源凭据（credentialId），据此排除即可。
   * 重新授权时排除的是「正在授权的账号自己」，其余仍然照常跳过。
   */
  const usedCredentialIds = new Set(
    site.accounts
      .filter((a) => a.id !== reauthAccountId)
      .map((a) => a.credentialId)
      .filter((id): id is string => !!id)
  )

  const usable = credentials.filter(
    (c) => c.provider === provider && !usedCredentialIds.has(c.id)
  )
  const alreadyAdded = credentials.filter(
    (c) => c.provider === provider && usedCredentialIds.has(c.id)
  )
  const passwordMode = provider === 'password'
  const canSubmit = passwordMode ? !!selected : true

  const submit = (): void => {
    if (canSubmit) onSubmit(site.id, provider, selected || undefined, reauthAccountId)
  }

  return (
    <Modal
      title={reauth ? `重新授权 · ${reauthAccount?.label ?? site.name}` : `添加账号 · ${site.name}`}
      onClose={onClose}
      onSubmit={submit}
      submitDisabled={!canSubmit}
    >
      {reauth && (
        <div className="hint" style={{ marginBottom: 12 }}>
          当前账号的会话已失效。完成一次登录即可替换它的会话，
          账号本身与历史记录都会保留。
        </div>
      )}
      <div className="modal-field">
        <label className="modal-label">登录方式</label>
        <div className="seg">
          {providers.map((p) => (
            <button
              key={p}
              className={provider === p ? 'seg-item active' : 'seg-item'}
              onClick={() => {
                setProvider(p as AuthProvider)
                setSelected('')
              }}
            >
              {providerLabel(p as AuthProvider)}
            </button>
          ))}
        </div>
      </div>

      <div className="modal-field">
        <label className="modal-label">
          {passwordMode ? '选择凭据' : '使用已保存的凭据'}
          <span className="modal-label-hint">{passwordMode ? '' : '（可选）'}</span>
        </label>
        <div className="cred-pick">
          {!passwordMode && (
            <button
              className={selected === '' ? 'cred-pick-item selected' : 'cred-pick-item'}
              onClick={() => setSelected('')}
            >
              <span className="cred-pick-avatar">
                <ExternalLink size={13} />
              </span>
              <span className="cred-pick-name">不预填</span>
              <span className="cred-pick-sub">打开窗口手动登录</span>
            </button>
          )}
          {usable.map((c) => (
            <button
              key={c.id}
              className={selected === c.id ? 'cred-pick-item selected' : 'cred-pick-item'}
              onClick={() => setSelected(c.id)}
            >
              <span className="cred-pick-avatar">{providerAvatar(c.provider)}</span>
              <span className="cred-pick-name">
                {c.displayName || c.username}
                {/* 有显示名称时补一行用户名，方便确认具体是哪个身份 */}
                {c.displayName && <span className="cred-pick-note">{c.username}</span>}
                {c.note && <span className="cred-pick-note">{c.note}</span>}
              </span>
              <span className="cred-pick-sub">
                {passwordMode
                  ? c.hasPassword
                    ? '密码已保存'
                    : '缺少密码'
                  : c.hasPassword && c.hasTotp
                    ? '密码 + 两步验证'
                    : c.hasPassword
                      ? '仅密码'
                      : '仅用户名'}
              </span>
            </button>
          ))}
        </div>
        {usable.length === 0 && (
          <div className="hint" style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <KeyRound size={14} style={{ flex: 'none', marginTop: 3 }} />
            <span>
              {alreadyAdded.length > 0 && usable.length === 0
                ? `该站点的 ${providerLabel(provider)} 凭据都已登录过，无需重复添加。如需追加，请先在「账号」页添加新的凭据。`
                : passwordMode
                  ? '还没有可用的邮箱/密码凭据。请先到左侧「账号」页添加，类型选「邮箱 / 密码」。'
                  : `还没有 ${providerLabel(provider)} 凭据。可以在左侧「账号」页先添加，之后就能一键登录，不用每次手输。`}
            </span>
          </div>
        )}
        {alreadyAdded.length > 0 && usable.length > 0 && (
          <div className="hint" style={{ marginTop: 8 }}>
            已跳过 {alreadyAdded.length} 个已在该站点登录过的凭据：
            {alreadyAdded.map((c) => c.displayName || c.username).join('、')}
          </div>
        )}
      </div>

      <div className="hint">
        {passwordMode
          ? '直接用用户名或邮箱加密码调用站点登录接口，不打开窗口。'
          : selected
            ? '授权窗口会在后台自动填写登录信息；遇到人工验证时窗口会自动弹出。'
            : '会打开一个登录窗口，由你完成登录。' +
              (usable.length > 0 ? '选择上面的凭据可以自动填写。' : '')}
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" disabled={!canSubmit} onClick={submit}>
          {passwordMode || selected ? <LogIn size={14} /> : <ExternalLink size={14} />}
          {passwordMode ? '登录' : selected ? '自动登录' : '打开登录窗口'}
        </button>
      </div>
    </Modal>
  )
}
