export function setupEnrollment({ request, action, notice, date }) {
  const $ = (id) => document.getElementById(id);
  let generation = 0;
  let expiry = 0;
  function clear() {
    generation++;
    expiry = 0;
    $('enrollment-command').value = '';
    $('enrollment-result').hidden = true;
    $('enrollment-node').replaceChildren();
    $('enrollment-options').hidden = true;
  }
  $('enrollment-open').addEventListener('click', () =>
    action(async () => {
      const active = generation;
      const result = await request('/monitor/enrollment');
      if (generation !== active) return;
      $('enrollment-node').replaceChildren();
      for (const node of result.nodes) {
        const option = document.createElement('option');
        option.value = node.nodeId;
        option.disabled = !node.ready;
        option.textContent =
          node.nodeId + (node.ready ? ` · v${node.version} · 已准备` : ' · 尚未准备安装包');
        $('enrollment-node').append(option);
      }
      const ready = result.nodes.find((node) => node.ready);
      if (ready) $('enrollment-node').value = ready.nodeId;
      $('enrollment-generate').disabled = !ready;
      $('enrollment-options').hidden = false;
    }),
  );
  $('enrollment-node').addEventListener('change', () => {
    $('enrollment-command').value = '';
    $('enrollment-result').hidden = true;
    expiry = 0;
  });
  $('enrollment-generate').addEventListener('click', () =>
    action(async () => {
      $('enrollment-command').value = '';
      $('enrollment-result').hidden = true;
      const active = generation;
      const result = await request('/monitor/enrollment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: $('enrollment-node').value }),
      });
      if (generation !== active) return;
      expiry = Date.parse(result.expiresAt);
      $('enrollment-command').value = result.command;
      $('enrollment-expiry').textContent =
        `有效期至 ${date(result.expiresAt)}，仅能领取一次。重新生成会撤销本节点旧命令。`;
      $('enrollment-result').hidden = false;
      notice('命令已生成。请在第一台 Ubuntu 控制台粘贴执行。');
    }),
  );
  $('enrollment-copy').addEventListener('click', () =>
    action(async () => {
      if (Date.now() >= expiry) {
        $('enrollment-command').value = '';
        throw new Error('命令已过期，请重新生成。');
      }
      try {
        await navigator.clipboard.writeText($('enrollment-command').value);
        notice('已复制。关闭 CC 客户端并结束任务后，在第一台 Ubuntu 控制台粘贴执行。');
      } catch {
        $('enrollment-command').focus();
        $('enrollment-command').select();
        notice('浏览器未允许自动复制，命令已选中，请按 Ctrl+C。');
      }
    }),
  );
  setInterval(() => {
    if (expiry && Date.now() >= expiry) {
      expiry = 0;
      $('enrollment-command').value = '';
      $('enrollment-expiry').textContent = '命令已过期，请重新生成。';
    }
  }, 1000);
  return { clear };
}
