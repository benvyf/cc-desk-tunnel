export function setupRelay({ request, action, notice }) {
  const $ = (id) => document.getElementById(id);
  const labels = {
    unconfigured: '尚未发布配置',
    queued: '等待同步',
    waiting: '等待空闲或服务支持',
    applying: '正在切换',
    applied: '公网验证中',
    succeeded: '验证成功',
    failed: '切换失败',
  };
  let preview,
    expiry,
    generation = 0;
  const post = (path, body) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  function invalidate() {
    preview = undefined;
    clearTimeout(expiry);
    $('relay-confirmation').hidden = true;
    $('relay-preview').textContent = '';
  }
  function clear() {
    generation++;
    invalidate();
    $('relay-form').reset();
    $('relay-nodes').replaceChildren();
    $('relay-command').value = '';
    $('relay-enrollment').hidden = true;
    $('relay-history').textContent = '';
  }
  function render(data) {
    const selected = new Set(
      [...$('relay-nodes').querySelectorAll('input:checked')].map((input) => input.value),
    );
    $('relay-nodes').replaceChildren();
    for (const node of data.nodes) {
      const row = document.createElement('div'),
        label = document.createElement('label'),
        input = document.createElement('input');
      label.className = 'check';
      input.type = 'checkbox';
      input.value = node.id;
      input.checked = selected.has(node.id);
      input.disabled = !node.inventory;
      input.addEventListener('change', invalidate);
      label.append(input, document.createTextNode(node.id));
      const status = document.createElement('p');
      status.className = 'muted';
      status.textContent = node.inventory
        ? `${node.inventory.host} → ${node.desired?.host ?? '未设置'} · ${labels[node.state] ?? node.state} · ${node.lastSeen ? new Date(node.lastSeen).toLocaleString('zh-CN') : '尚未上报'}${node.lastSeen && Date.now() - node.lastSeen > 90000 ? ' · 离线，恢复后补同步' : ''}${node.message ? ' · ' + node.message : ''}`
        : '尚未接入自动同步，请先在这台 Ubuntu 执行一次接入命令。';
      const enroll = document.createElement('button');
      enroll.type = 'button';
      enroll.className = 'quiet';
      enroll.textContent = '接入 ' + node.id;
      enroll.onclick = () => {
        const current = generation;
        void action(async () => {
          const grant = await post(`/host-updates/${encodeURIComponent(node.id)}/enrollment`, {});
          if (current !== generation) return;
          $('relay-command').value = grant.command;
          $('relay-enrollment').hidden = false;
          $('relay-enrollment-label').textContent =
            `在 ${node.id} 上执行（仅接入通道，不更换 IP、不升级程序）`;
        });
      };
      row.append(label, status, enroll);
      $('relay-nodes').append(row);
    }
    $('relay-history').textContent = data.history
      .map(
        (item) =>
          `版本 ${item.revision} · ${item.host} · ${item.administrator} · ${new Date(item.created).toLocaleString('zh-CN')}`,
      )
      .join('\n');
  }
  $('relay-host').addEventListener('input', invalidate);
  $('relay-form').addEventListener('submit', (event) => {
    event.preventDefault();
    invalidate();
    const current = generation;
    const host = $('relay-host').value.trim(),
      nodes = [...$('relay-nodes').querySelectorAll('input:checked')].map((input) => input.value);
    void action(async () => {
      const result = await post('/relay/preview', { host, nodes });
      // An edit made while network preflight was in flight invalidates its result too.
      const latest = [...$('relay-nodes').querySelectorAll('input:checked')].map(
        (input) => input.value,
      );
      if (
        current !== generation ||
        $('relay-host').value.trim() !== host ||
        JSON.stringify(latest) !== JSON.stringify(nodes)
      )
        return;
      preview = result;
      $('relay-preview').textContent =
        `新 IP：${result.host}；SSH 主机身份已核验。\n影响节点：${result.targets.map((node) => node.id).join('、')}。\n隧道切换会短暂断线；活动任务完成后执行。离线节点恢复后补同步。`;
      $('relay-confirmation').hidden = false;
      expiry = setTimeout(invalidate, Math.max(0, result.expires - Date.now()));
    });
  });
  $('relay-confirm').onclick = () => {
    void action(async () => {
      if (!preview || preview.expires <= Date.now()) {
        invalidate();
        throw Error('预检已过期，请重新检查。');
      }
      const id = preview.id,
        current = generation;
      invalidate();
      const data = await post('/relay/publish', { previewId: id, confirmed: true });
      if (current !== generation) return;
      render(data);
      notice('新中转 IP 已发布，等待各台 Ubuntu 同步并验收。');
    });
  };
  $('relay-cancel').onclick = invalidate;
  $('relay-refresh').onclick = () => {
    void action(refresh);
  };
  $('relay-copy').onclick = () => {
    void action(async () => {
      await navigator.clipboard.writeText($('relay-command').value);
      notice('接入命令已复制，请只在对应 Ubuntu 执行。');
    });
  };
  async function refresh() {
    const current = generation;
    const data = await request('/relay');
    if (current === generation) render(data);
  }
  return { clear, refresh };
}
