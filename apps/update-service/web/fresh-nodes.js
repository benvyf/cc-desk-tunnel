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
  }
  $('fresh-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action(async () => {
      const active = ++generation;
      expiresAt = 0;
      $('fresh-command').value = '';
      $('fresh-result').hidden = true;
      const result = await request('/fresh-nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: $('fresh-node').value.trim() }),
      });
      if (active !== generation) return;
      expiresAt = Date.parse(result.expiresAt);
      $('fresh-command').value = result.command;
      $('fresh-expiry').textContent =
        `${result.nodeId} · Build ${result.build} · ${date(result.expiresAt)} 前领取，仅一次。同名重新生成会撤销旧命令。`;
      $('fresh-result').hidden = false;
      notice('请在新 Ubuntu 虚拟机控制台粘贴执行，安装期间保持终端打开。');
    });
  });
  $('fresh-node').addEventListener('input', () => {
    generation++;
    expiresAt = 0;
    $('fresh-command').value = '';
    $('fresh-result').hidden = true;
  });
  $('fresh-copy').addEventListener('click', () =>
    action(async () => {
      if (!expiresAt || Date.now() >= expiresAt) throw new Error('命令已过期，请重新生成。');
      try {
        await navigator.clipboard.writeText($('fresh-command').value);
        notice('已复制，请在新 Ubuntu 虚拟机执行。');
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
