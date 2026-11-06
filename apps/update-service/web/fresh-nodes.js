export function setupFreshNodes({ request, action, notice, date }) {
  const $ = (id) => document.getElementById(id);
  let generation = 0;
  let expiresAt = 0;
  function clear() {
    generation++;
    expiresAt = 0;
    $('fresh-command').value = '';
    $('fresh-result').hidden = true;
    $('fresh-node').value = '';
    $('fresh-reset').checked = false;
  }
  $('fresh-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action(async () => {
      const active = ++generation;
      expiresAt = 0;
      $('fresh-command').value = '';
      $('fresh-result').hidden = true;
      const reset = $('fresh-reset').checked;
      const result = await request('/fresh-nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodeId: $('fresh-node').value.trim(),
          ...(reset ? { resetExisting: true } : {}),
        }),
      });
      if (active !== generation) return;
      expiresAt = Date.parse(result.expiresAt);
      $('fresh-command').value = result.command;
      $('fresh-expiry').textContent =
        `${result.nodeId} · ${reset ? '清空重装' : '全新安装'} · Build ${result.build} · ${date(result.expiresAt)} 前领取，仅限一台机器。同名重新生成会撤销旧命令。`;
      $('fresh-result').hidden = false;
      notice(
        reset
          ? '请在目标 Ubuntu 执行；主机名必须与节点名称一致。新版检查通过后才停止旧服务，旧数据隔离保留。'
          : '请在新 Ubuntu 虚拟机控制台粘贴执行，安装期间保持终端打开。',
      );
    });
  });
  function invalidate() {
    generation++;
    expiresAt = 0;
    $('fresh-command').value = '';
    $('fresh-result').hidden = true;
  }
  $('fresh-node').addEventListener('input', invalidate);
  $('fresh-reset').addEventListener('change', invalidate);
  $('fresh-copy').addEventListener('click', () =>
    action(async () => {
      if (!expiresAt || Date.now() >= expiresAt) throw new Error('命令已过期，请重新生成。');
      try {
        await navigator.clipboard.writeText($('fresh-command').value);
        notice('已复制，请在对应 Ubuntu 虚拟机执行。');
      } catch {
        $('fresh-command').focus();
        $('fresh-command').select();
        notice('命令已选中，请按 Ctrl+C。');
      }
    }),
  );
  setInterval(() => {
    if (expiresAt && Date.now() >= expiresAt) {
      expiresAt = 0;
      $('fresh-command').value = '';
      $('fresh-expiry').textContent = '命令已过期，请重新生成。';
    }
  }, 1000);
  return { clear };
}
