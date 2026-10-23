export function setupServerDownload({ request, element, notice }) {
  const root = document.getElementById('server-download');
  let generation = 0;
  function clear() {
    generation++;
    root.replaceChildren();
  }
  async function refresh() {
    const active = ++generation;
    const status = await request('/server');
    if (active !== generation) return;
    root.replaceChildren();
    if (!status.published) {
      root.append(element('p', '配套 Linux 服务端尚未发布。', 'muted'));
      return;
    }
    const release = status.payload.release;
    root.append(
      element(
        'h3',
        `Linux x64 · v${release.appVersion} · Build ${release.build} · 协议 ${release.protocol}`,
      ),
    );
    root.append(element('p', `SHA256：${release.sha256}`, 'muted'));
    if (status.expired) {
      root.append(element('p', '签名索引已过期，等待管理员续期后再安装。', 'error'));
      return;
    }
    const link = element('a', '下载完整配套服务端');
    link.href = status.downloadPath;
    link.download = '';
    root.append(link);
    root.append(
      element(
        'p',
        '包含当前服务端、配套 Web 和部署文件。仅第一台 ubuntu-cc 支持首次接入；先结束任务并关闭 CC 客户端，在 Ubuntu 控制台执行下方命令。安装会短暂重启服务并保存本地备份；后续升级由 CC 展示目标后确认。',
        'muted',
      ),
    );
    const label = element('label', '首次接入命令');
    label.htmlFor = 'server-bootstrap-command';
    const command = element('textarea');
    command.id = 'server-bootstrap-command';
    command.readOnly = true;
    command.rows = 6;
    command.spellcheck = false;
    command.value = status.command;
    const copy = element('button', '复制首次接入命令', 'quiet');
    copy.addEventListener('click', async () => {
      if (active !== generation || Date.parse(status.payload.expiresAt) <= Date.now()) {
        clear();
        notice('签名已过期，请刷新发布信息。', true);
        return;
      }
      try {
        await navigator.clipboard.writeText(command.value);
        notice('已复制，请在第一台 Ubuntu 控制台执行。');
      } catch {
        command.focus();
        command.select();
        notice('命令已选中，请按 Ctrl+C。');
      }
    });
    root.append(label, command, copy);
  }
  return { clear, refresh };
}
