export function setupNodeUpdates({ request, action, notice }) {
  const $ = (id) => document.getElementById(id);
  let nodeId,
    data,
    generation = 0,
    timer,
    grant;
  const post = (path, body) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const labels = {
    queued: '等待设备接收',
    running: '正在更新',
    succeeded: '更新成功',
    failed: '更新未完成',
  };
  function render() {
    $('node-update-channel').textContent = !data.enrolled
      ? '尚未接入宿主机更新通道'
      : data.online
        ? '宿主机更新通道在线'
        : '等待宿主机连接';
    $('node-update-current').textContent = data.current
      ? `当前 Build ${data.current.build}／协议 ${data.current.protocol}`
      : '尚未读取本机服务版本';
    $('node-update-target').textContent = data.release
      ? `可用版本：Build ${data.release.build}／协议 ${data.release.protocol} · SHA256 ${data.release.sha256}`
      : '暂无有效的已签名发布';
    const busy = data.job && ['queued', 'running'].includes(data.job.state);
    $('node-update-install').disabled =
      !data.online ||
      !data.current ||
      !data.release ||
      busy ||
      data.current.build >= data.release.build;
    $('node-update-install').textContent =
      data.current && data.release && data.current.build >= data.release.build
        ? '已是当前或更高版本'
        : `更新到 Build ${data.release?.build ?? '…'}`;
    $('node-update-enroll').disabled = !!busy;
    $('node-update-job').textContent = data.job
      ? `${labels[data.job.state]} · Build ${data.job.build}`
      : '尚未提交更新任务';
    $('node-update-progress').textContent = data.job?.progress ?? '';
  }
  async function refresh(epoch = generation) {
    clearTimeout(timer);
    try {
      const next = await request(`/host-updates/${nodeId}`);
      if (epoch !== generation) return;
      data = next;
      render();
      $('node-update-error').textContent = '';
    } catch (error) {
      if (epoch === generation && error.name !== 'AbortError')
        $('node-update-error').textContent = error.message;
    } finally {
      if (epoch === generation && nodeId)
        timer = setTimeout(() => {
          if (!document.hidden) void refresh(epoch);
          else timer = setTimeout(() => void refresh(epoch), 5000);
        }, 5000);
    }
  }
  function clear() {
    generation++;
    clearTimeout(timer);
    nodeId = undefined;
    data = undefined;
    grant = undefined;
    $('node-update-panel').hidden = true;
    $('node-update-confirmation').hidden = true;
    $('node-update-command').value = '';
    $('node-update-enrollment').hidden = true;
    $('node-update-progress').textContent = '';
    $('node-update-error').textContent = '';
    $('node-update-channel').textContent = '正在读取宿主机更新通道';
    $('node-update-current').textContent = '';
    $('node-update-target').textContent = '';
    $('node-update-job').textContent = '';
    $('node-update-install').disabled = true;
    $('node-update-enroll').disabled = true;
  }
  $('node-update-close').onclick = clear;
  $('node-update-refresh').onclick = () => void refresh();
  $('node-update-enroll').onclick = () =>
    void action(async () => {
      const epoch = generation;
      const next = await post(`/host-updates/${nodeId}/enrollment`, {});
      if (epoch !== generation) return;
      grant = next;
      $('node-update-command').value = grant.command;
      $('node-update-enrollment').hidden = false;
      notice('在对应 Ubuntu 控制台执行一次接入命令；接入不会自动升级服务端。');
    });
  $('node-update-copy').onclick = () =>
    void action(async () => {
      if (!grant || Date.parse(grant.expiresAt) <= Date.now())
        throw new Error('接入命令已过期，请重新生成。');
      await navigator.clipboard.writeText(grant.command);
      notice('已复制一次性宿主机接入命令。');
    });
  $('node-update-install').onclick = () => {
    if (!data?.release || $('node-update-install').disabled) return;
    $('node-update-confirm-text').textContent =
      `确认更新 ${nodeId} 到 Build ${data.release.build}／协议 ${data.release.protocol}？更新会暂时中断服务，请先结束任务并关闭原生终端。`;
    $('node-update-confirmation').hidden = false;
    $('node-update-confirm').dataset.build = String(data.release.build);
    $('node-update-confirm').dataset.sha256 = data.release.sha256;
  };
  $('node-update-cancel').onclick = () => {
    $('node-update-confirmation').hidden = true;
  };
  $('node-update-confirm').onclick = () =>
    void action(async () => {
      const epoch = generation;
      await post(`/host-updates/${nodeId}/install`, {
        confirmed: true,
        build: Number($('node-update-confirm').dataset.build),
        sha256: $('node-update-confirm').dataset.sha256,
      });
      if (epoch !== generation) return;
      $('node-update-confirmation').hidden = true;
      await refresh(epoch);
      notice('更新任务已提交；只有目标设备会执行。请等待明确的成功结果。');
    });
  return {
    async open(id) {
      clear();
      nodeId = id;
      $('node-update-heading').textContent = `${id} · 服务端更新`;
      $('node-update-panel').hidden = false;
      $('node-update-install').disabled = true;
      await refresh();
      $('node-update-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    clear,
  };
}
