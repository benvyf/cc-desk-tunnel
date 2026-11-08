const $ = (id) => document.getElementById(id);
export function setupPasswordLogin({ action, notice, login, request }) {
  let setupToken = new URLSearchParams(location.hash.slice(1)).get('setup') ?? '';
  if (setupToken) {
    history.replaceState(null, '', location.pathname);
    $('login-panel').hidden = true;
    $('password-setup-panel').hidden = false;
  }
  async function authenticate(path, data) {
    const response = await fetch('/cc-updates/admin/api/auth/' + path, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? `登录失败（HTTP ${response.status}）。`);
    return result.sessionToken;
  }
  $('password-login').addEventListener('submit', (event) => {
    event.preventDefault();
    void action(async () => {
      const password = $('admin-password').value;
      $('admin-password').value = '';
      await login(await authenticate('login', { password }));
    });
  });
  $('password-setup').addEventListener('submit', (event) => {
    event.preventDefault();
    void action(async () => {
      const password = $('new-admin-password').value;
      const confirmation = $('confirm-admin-password').value;
      $('new-admin-password').value = '';
      $('confirm-admin-password').value = '';
      if (password !== confirmation) throw new Error('两次输入的密码不一致，请重新输入。');
      const session = await authenticate('setup', { setupToken, password });
      setupToken = '';
      $('password-setup-panel').hidden = true;
      await login(session);
      notice('管理员密码已设置，已登录。');
    });
  });
  $('change-password').addEventListener('click', () => {
    $('password-change-panel').hidden = !$('password-change-panel').hidden;
    if (!$('password-change-panel').hidden) {
      $('password-change-panel').scrollIntoView();
      $('current-admin-password').focus();
    } else $('password-change').reset();
  });
  $('cancel-password-change').addEventListener('click', () => {
    $('password-change').reset();
    $('password-change-panel').hidden = true;
  });
  $('password-change').addEventListener('submit', (event) => {
    event.preventDefault();
    void action(async () => {
      const currentPassword = $('current-admin-password').value;
      const newPassword = $('changed-admin-password').value;
      const confirmation = $('confirm-changed-password').value;
      $('password-change').reset();
      if (newPassword !== confirmation) throw new Error('两次输入的新密码不一致，请重新输入。');
      const result = await request('/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      await login(result.sessionToken);
      $('password-change-panel').hidden = true;
      notice('密码已修改，当前保持登录；其他登录会话已失效。');
    });
  });
  return {
    clear() {
      $('password-login').reset();
      $('password-setup').reset();
      $('password-change').reset();
      $('password-change-panel').hidden = true;
    },
  };
}
