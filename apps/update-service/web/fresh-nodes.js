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
  function generate(resume = false) {
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
          ...(resume ? { resumeExisting: true } : {}),
        }),
      });
      if (active !== generation) return;
      expiresAt = resume ? 0 : Date.parse(result.expiresAt);
      $('fresh-command').value = result.command;
      $('fresh-expiry').textContent = resume
        ? `${result.nodeId} · ${reset ? '清空重装续装' : '续装'} · 仅使用本机已领取的安装缓存，无需安装码；命令无领取期限。`
        : `${result.nodeId} · ${reset ? '清空重装' : '全新安装'} · Build ${result.build} · ${date(result.expiresAt)} 前领取，仅限一台机器。同名重新生成会撤销旧命令。`;
      $('fresh-result').hidden = false;
      notice(
        resume
          ? '请仅在原 Ubuntu 执行，并保留 /var/lib/cc-fresh-install 安装缓存；节点名称和控制中心必须与缓存一致。'
          : reset
            ? '请在目标 Ubuntu 执行；主机名必须与节点名称一致。备份本次操作前正常运行的环境，新版验证成功后清理更早的备份大文件。'
            : '请在新 Ubuntu 虚拟机控制台粘贴执行，安装期间保持终端打开。',
      );
    });
  }
  $('fresh-form').addEventListener('submit', (event) => {
    event.preventDefault();
    generate();
  });
  $('fresh-resume').addEventListener('click', () => {
    if ($('fresh-form').reportValidity()) generate(true);
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
      if (!$('fresh-command').value || (expiresAt && Date.now() >= expiresAt))
        throw new Error('命令已过期，请重新生成。');
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
