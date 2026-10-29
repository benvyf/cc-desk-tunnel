export function setupDesktopAccess({ request, action, notice, date, monitor }) {
  const $ = (id) => document.getElementById(id);
  let data, nodeId, userId;
  const node = () => data.nodes.find((item) => item.id === nodeId);
  function tab(selected) {
    for (const name of ['claude', 'connection', 'users']) {
      $('access-' + name).hidden = name !== selected;
      $('access-' + name + '-tab').setAttribute('aria-selected', String(name === selected));
      $('access-' + name + '-tab').tabIndex = name === selected ? 0 : -1;
    }
  }
  function render() {
    const current = node();
    $('desktop-access-heading').textContent = nodeId;
    $('access-node-id').value = nodeId;
    $('access-node-name').value = current.name;
    $('access-node-url').value = current.url;
    $('access-node-fingerprint').value = current.fingerprint;
    $('access-node-credential').value = '';
    $('access-credential-state').textContent = current.credentialSaved
      ? '凭据已加密保存，不回显。'
      : '尚未保存服务凭据；从客户端管理远端升级前，请先补全。';
    $('access-user-list').replaceChildren();
    for (const user of data.users) {
      const row = document.createElement('tr');
      for (const text of [
        user.email,
        user.enabled ? '已启用' : '已停用',
        user.nodes.join('、') || '尚未分配',
        user.lastLogin ? date(user.lastLogin) : '尚未登录',
      ]) {
        const td = document.createElement('td');
        td.textContent = text;
        row.append(td);
      }
      const cell = document.createElement('td'),
        button = document.createElement('button');
      button.type = 'button';
      button.className = 'quiet';
      button.textContent = '编辑 / 重置密码';
      button.onclick = () => edit(user);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'quiet';
      toggle.textContent = user.enabled ? '停用' : '启用';
      toggle.onclick = () => {
        void action(async () => {
          data = await request(`/desktop-access/users/${user.id}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: user.email,
              enabled: !user.enabled,
              nodes: user.nodes,
            }),
          });
          if (userId === user.id) $('access-user-form').hidden = true;
          render();
          notice(user.enabled ? '用户已停用，原有登录已撤销。' : '用户已启用。');
        });
      };
      cell.append(toggle, button);
      row.append(cell);
      $('access-user-list').append(row);
    }
  }
  function edit(user) {
    userId = user?.id;
    $('access-user-form').reset();
    $('access-user-email').value = user?.email ?? '';
    $('access-user-enabled').checked = user?.enabled ?? true;
    $('access-user-password').required = !user;
    $('access-user-nodes').replaceChildren();
    for (const workspace of data.nodes) {
      const label = document.createElement('label');
      label.className = 'check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = workspace.id;
      checkbox.checked = user ? user.nodes.includes(workspace.id) : workspace.id === nodeId;
      label.append(checkbox, document.createTextNode(`${workspace.name}（${workspace.id}）`));
      $('access-user-nodes').append(label);
    }
    $('access-user-form').hidden = false;
    $('access-user-email').focus();
  }
  $('access-users-tab').onclick = () => tab('users');
  $('access-connection-tab').onclick = () => tab('connection');
  $('access-claude-tab').onclick = () => tab('claude');
  for (const [index, name] of ['claude', 'connection', 'users'].entries()) {
    $('access-' + name + '-tab').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? 2
            : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      const target = ['claude', 'connection', 'users'][next];
      tab(target);
      $('access-' + target + '-tab').focus();
    });
  }
  $('desktop-access-close').onclick = () => {
    monitor?.closeNode();
    $('desktop-access-panel').hidden = true;
    $('access-user-form').reset();
    $('access-node-credential').value = '';
    $('monitor-nodes').querySelector(`[data-node-id="${nodeId}"] button`)?.focus();
  };
  $('access-user-add').onclick = () => edit();
  $('access-user-cancel').onclick = () => {
    $('access-user-form').hidden = true;
    $('access-user-form').reset();
  };
  $('access-node-form').onsubmit = (event) => {
    event.preventDefault();
    void action(async () => {
      data = await request(`/desktop-access/nodes/${nodeId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: $('access-node-name').value,
          url: $('access-node-url').value.trim(),
          fingerprint: $('access-node-fingerprint').value.trim(),
          credential: $('access-node-credential').value,
        }),
      });
      render();
      notice('连接配置已保存。');
    });
  };
  $('access-user-form').onsubmit = (event) => {
    event.preventDefault();
    void action(async () => {
      const input = {
        email: $('access-user-email').value,
        password: $('access-user-password').value,
        enabled: $('access-user-enabled').checked,
        nodes: [...$('access-user-nodes').querySelectorAll('input:checked')].map((x) => x.value),
      };
      data = await request(`/desktop-access/users${userId ? '/' + userId : ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      $('access-user-form').reset();
      $('access-user-form').hidden = true;
      render();
      notice('用户已保存，原有登录已撤销。');
    });
  };
  return {
    async open(id, selected = 'connection') {
      data = await request('/desktop-access');
      nodeId = id;
      if (!node()) throw new Error('设备不存在，请刷新账号监控。');
      $('access-user-form').hidden = true;
      render();
      monitor?.showNode(id);
      tab(selected);
      $('desktop-access-panel').hidden = false;
      $('desktop-access-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    clear() {
      data = null;
      nodeId = undefined;
      userId = undefined;
      $('desktop-access-panel').hidden = true;
      $('access-user-form').reset();
      $('access-node-form').reset();
      $('access-user-list').replaceChildren();
    },
  };
}
