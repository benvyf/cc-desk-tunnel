const $ = (id) => document.getElementById(id);
export function setupPasswordLogin({ action, notice, login }) {
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
  return {
    clear() {
      $('password-login').reset();
      $('password-setup').reset();
    },
  };
}
