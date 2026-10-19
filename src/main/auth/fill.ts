/**
 * 登录页与授权页的自动填充脚本。
 *
 * 三支脚本：
 *   - githubLoginScript：GitHub 登录页 / 两步验证页
 *   - githubAuthorizeScript：GitHub OAuth 授权确认页（已登录时点「Authorize」）
 *   - linuxdoLoginScript / linuxdoApproveScript：Linux DO 对应页面
 *
 * 设计约束（重要）：
 *   1. 只填真实存在的表单字段，找不到就不填，绝不猜选择器乱点
 *   2. 每次注入最多提交一次，避免重复提交触发风控
 *   3. 授权确认页的「允许」是一次性动作，重复点击会让 token 失效
 *   4. 检测到可见的人机验证挂件、设备验证、无 TOTP 的二次验证时立即停手交还用户
 *   5. 凭据经 executeJavaScript 参数传入，脚本本身不含明文
 */

export interface FillPayload {
  username: string
  password?: string
  /** 本次现算的 TOTP 码。 */
  otp?: string
}

/** 注入脚本共用的 DOM 工具。 */
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const pick = (sel) => {
    for (const el of document.querySelectorAll(sel)) {
      if (visible(el) && !el.disabled && !el.readOnly) return el;
    }
    return null;
  };
  const setValue = (el, v) => {
    if (!el || !v) return false;
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    // React / Vue / Ember 的受控组件只认这些事件序列
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  };
  const click = (el) => {
    if (!el || !visible(el)) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    el.click();
    return true;
  };
  /* 人机验证：只有在挂件可见且尚未产出 token 时才拦下自动提交 */
  const captchaPending = () => {
    const boxes = document.querySelectorAll(
      '.cf-turnstile,#cf-turnstile,[data-sitekey],.g-recaptcha,.h-captcha,#altcha'
    );
    let shown = false;
    for (const b of boxes) if (visible(b)) shown = true;
    if (!shown) return false;
    const token = document.querySelector(
      '[name="cf-turnstile-response"],[name="g-recaptcha-response"],[name="h-captcha-response"]'
    );
    return !(token && token.value && token.value.length > 10);
  };
`

/** 当前页面是否需要填 GitHub 登录表单。 */
export function githubLoginScript(payload: FillPayload): string {
  return `(async () => {
  const U = ${JSON.stringify(payload.username)};
  const P = ${JSON.stringify(payload.password ?? '')};
  const O = ${JSON.stringify(payload.otp ?? '')};
  ${HELPERS}
  const out = (step, done, msg) => JSON.stringify({ step, done, msg: msg || '' });

  if (location.hostname !== 'github.com') return out('not-login-page', true);
  if (!/^github\\.com$/i.test(location.hostname)) return out('not-login-page', true);

  // 设备验证 / 异常登录确认：只能人工处理，不做任何尝试
  if (/verified-device|device-verification/i.test(location.pathname + location.search)) {
    return out('manual', true, 'GitHub 要求设备验证，需要人工完成');
  }

  const otp = pick('input[name="app_otp"],#app_otp,#otp,input[autocomplete="one-time-code"]')
    || pick('input[name*="otp" i],input[name*="totp" i]');

  // 两步验证页：填码并提交
  if (otp) {
    if (!O) return out('need-otp', true, '该账号需要两步验证，但凭据里没有 TOTP 密钥');
    if (!setValue(otp, O)) return out('fill-failed', true, '两步验证输入框不可填');
    await sleep(150);
    click(pick('form button[type="submit"],button[type="submit"],button[name="commit"]'));
    return out('submitted-otp', true);
  }

  // 两步验证页但默认方式是 GitHub Mobile / 安全密钥：切到验证器输入
  if (O && /two-factor|sessions/i.test(location.pathname)) {
    const els = [...document.querySelectorAll('a,button,summary')].filter((el) => visible(el));
    const link = els.find(
      (el) => /authenticator|verification code|验证器|验证码/i.test(el.textContent || '') &&
        !/passkey|security key|sms|短信|recovery|恢复码/i.test(el.textContent || '')
    );
    if (link) {
      click(link);
      await sleep(500);
      return out('switched-2fa', false);
    }
    const more = els.find((el) => /other options|more options|其他方式|更多选项/i.test(el.textContent || ''));
    if (more) {
      click(more);
      await sleep(400);
      return out('expanded-2fa', false);
    }
    return out('manual', true, 'GitHub 两步验证页没有验证码输入框，可能需要推送批准');
  }

  const acc = pick('#login_field,input[name="login"],input[autocomplete="username"]');
  const pwd = pick('#password,input[name="password"],input[type="password"]');

  if (acc && pwd) {
    if (captchaPending()) return out('manual', true, '登录页要求人机验证，需要人工完成');
    if (!P) return out('partial', true, '凭据里没有密码，无法自动登录');
    if (!setValue(acc, U) || !setValue(pwd, P)) {
      return out('partial', true, '登录表单字段填充失败');
    }
    // 等按钮就绪再点，且只点一次
    for (let i = 0; i < 20; i++) {
      const btn = pick('form button[type="submit"],input[type="submit"],button[type="submit"]');
      if (btn) {
        click(btn);
        return out('submitted', true);
      }
      await sleep(120);
    }
    const form = acc.closest('form');
    if (form) {
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
      return out('submitted', true);
    }
    return out('no-submit', true, '找不到登录按钮');
  }

  // 页面还在渲染：让调用方稍后重试
  if (/^\\/login|^\\/session/i.test(location.pathname)) {
    return out('no-form', false, '登录表单尚未渲染');
  }
  return out('not-login-page', true);
})()`
}

/**
 * GitHub OAuth 授权确认页：点「Authorize」。
 *
 * 已登录 GitHub 时窗口会直接落到这个页面。不点它就永远回不到站点，
 * 表现为「预填完成后卡住」。按钮是 React 渲染的，需要轮询等待。
 *
 * 只认明确的授权按钮：`name=authorize` 或专属 id / testid。
 * **绝不能按「表单里第一个 submit」去找** —— 同一表单里的 Cancel 也是 submit，
 * 顺序一变就会点到取消，回调带 `error=access_denied`，表现为授权被拒。
 *
 * 「允许」是一次性动作：重复点击会让回调拿到废码，故用 sessionStorage 闸门。
 */
export function githubAuthorizeScript(): string {
  return `(async () => {
  ${HELPERS}
  const out = (step, done, msg) => JSON.stringify({ step, done, msg: msg || '' });
  if (location.hostname !== 'github.com') return out('not-authorize', true);

  // 站点后台登记的客户端与回传地址不匹配：这是站点配置问题，重试无用，直接报出来
  const pageText = document.body ? (document.body.innerText || '') : '';
  if (/redirect_uri.*is not associated with this application/i.test(pageText) ||
      /Invalid Redirect URI/i.test(document.title || '')) {
    return out('invalid-redirect', true, '站点的 OAuth 应用未登记该回调地址');
  }

  if (!location.pathname.startsWith('/login/oauth/authorize')) return out('not-authorize', true);
  // 未登录时会先落到登录表单：交给登录脚本处理，这里立即返回
  if (document.querySelector('#login_field,#login-account-name')) return out('need-login', true);

  /* 授权按钮判定：必须是明确的「同意」，名字或文案含取消/拒绝的一律排除 */
  const isApprove = (el) => {
    if (!el || el.disabled) return false;
    const name = (el.getAttribute('name') || '').toLowerCase();
    const value = (el.getAttribute('value') || '').toLowerCase();
    const text = ((el.textContent || '') + ' ' + (el.value || '')).trim().toLowerCase();
    if (name === 'cancel' || name === 'deny' || value === '0') return false;
    if (/cancel|deny|拒绝|取消/.test(text) && !/authorize/.test(text)) return false;
    return name === 'authorize' || /authorize/i.test(text);
  };

  const findApprove = () =>
    pick('#js-oauth-authorize-btn') ||
    pick('button[name="authorize"],input[name="authorize"]') ||
    pick('button[data-testid="oauth-authorize-button"]');

  for (let i = 0; i < 60; i++) {
    const btn = findApprove();
    if (btn && isApprove(btn)) {
      /* 一次性闸门按「本轮 state」区分：同一轮重载不再点，新一轮授权仍可点。
       * 若按路径做键，用户重新发起授权会永远被拦住。 */
      const state = new URLSearchParams(location.search).get('state') || '';
      const key = '__autosign_authorized:' + state;
      try {
        if (state && sessionStorage.getItem(key) === '1') return out('already-authorized', true);
        if (state) sessionStorage.setItem(key, '1');
      } catch (e) {}
      const label = (btn.textContent || btn.value || '').trim().slice(0, 30);
      click(btn);
      return out('authorized', true, label);
    }
    await sleep(200);
  }
  return out('authorize-missing', true, '授权页没有找到 Authorize 按钮');
})()`
}

/** Linux DO 授权确认页：点「允许」（Doorkeeper 的 approve 链接）。 */
export function linuxdoApproveScript(): string {
  return `(async () => {
  ${HELPERS}
  const out = (step, done, msg) => JSON.stringify({ step, done, msg: msg || '' });
  if (!/connect\\.linux\\.do$/i.test(location.hostname)) return out('not-authorize', true);

  for (let i = 0; i < 60; i++) {
    // 明确匹配 approve，绝不误点 decline
    const link = pick('a[href*="/oauth2/approve"]');
    const form = document.querySelector('form[action*="approve"]');
    const btn = link || (form ? form.querySelector('input[type="submit"],button[type="submit"],button,.btn') : null)
      || [...document.querySelectorAll('a,button,input[type="submit"]')].find(
        (el) => visible(el) && /^(允许|approve|authorize)$/i.test((el.textContent || el.value || '').trim())
      );
    if (btn) {
      const key = '__autosign_approved:' + (btn.getAttribute('href') || location.pathname);
      try {
        if (sessionStorage.getItem(key) === '1') return out('already-authorized', true);
        sessionStorage.setItem(key, '1');
      } catch (e) {}
      click(btn);
      return out('authorized', true);
    }
    await sleep(200);
  }
  return out('authorize-missing', true, '授权页没有找到允许按钮');
})()`
}

/** Linux DO（Discourse）登录表单。 */
export function linuxdoLoginScript(payload: FillPayload): string {
  return `(async () => {
  const U = ${JSON.stringify(payload.username)};
  const P = ${JSON.stringify(payload.password ?? '')};
  const O = ${JSON.stringify(payload.otp ?? '')};
  ${HELPERS}
  const out = (step, done, msg) => JSON.stringify({ step, done, msg: msg || '' });

  if (captchaPending()) return out('manual', true, '登录页要求人机验证，需要人工完成');

  // Discourse 两步验证页
  const otp = pick('#second-factor input,input[name="second_factor"],input[autocomplete="one-time-code"]');
  if (otp) {
    if (!O) return out('need-otp', true, '该账号需要两步验证，但凭据里没有 TOTP 密钥');
    setValue(otp, O);
    await sleep(150);
    click(pick('#second-factor button,.second-factor button[type="submit"],button[type="submit"]'));
    return out('submitted-otp', true);
  }

  // 登录前的公告弹窗会挡住表单，先关掉
  for (const c of document.querySelectorAll('.modal-close,.btn-close,.d-modal-cancel')) {
    if (visible(c)) { click(c); await sleep(200); break; }
  }

  const login = pick('#login-account-name,input[name="login"],input[id="login-account-name"]');
  const pass = pick('#login-account-password,input[name="password"],input[id="login-account-password"]');
  if (login && pass) {
    if (!P) return out('partial', true, '凭据里没有密码，无法自动登录');
    setValue(login, U);
    setValue(pass, P);
    await sleep(150);
    const btn = pick('#login-button,button[type="submit"],form.login-form button');
    if (btn) click(btn);
    else {
      const form = login.closest('form');
      if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
    }
    return out('submitted', true);
  }

  if (/\\/login|\\/session/i.test(location.pathname)) return out('no-form', false, '登录表单尚未渲染');
  return out('not-login-page', true);
})()`
}
