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
        '包含当前服务端、配套 Web 和部署文件。服务端升级适用于已接入受管更新、且每台虚拟机仅运行一个 CC 服务容器的兼容节点；首次接入仍仅适用于已审查的第一台 ubuntu-cc。执行前结束任务并完全退出所有 CC 连接（包括托盘）；升级期间保持 Ubuntu 终端打开。',
        'muted',
      ),
    );
    function appendCommand(id, title, text, value) {
      root.append(element('h3', title), element('p', text, 'muted'));
      const label = element('label', title + '命令');
      label.htmlFor = id;
      const command = element('textarea');
      command.id = id;
      command.readOnly = true;
      command.rows = 6;
      command.spellcheck = false;
      command.value = value;
      const copy = element('button', '复制' + title + '命令', 'quiet');
      copy.addEventListener('click', async () => {
        if (active !== generation || Date.parse(status.payload.expiresAt) <= Date.now()) {
          clear();
          notice('签名已过期，请刷新发布信息。', true);
          return;
        }
        try {
          await navigator.clipboard.writeText(command.value);
          notice(
            '已复制' +
              title +
              '命令，' +
              (id === 'server-upgrade-command'
                ? '请在需要升级的 Ubuntu 控制台执行。'
                : '请在已审查的第一台 Ubuntu 控制台执行。'),
          );
        } catch {
          command.focus();
          command.select();
          notice('命令已选中，请按 Ctrl+C。');
        }
      });
      root.append(label, command, copy);
    }
    if (status.baseUpgradeCommand)
      appendCommand(
        'server-base-upgrade-command',
        '基础镜像升级（ubuntu-cc）',
        '当前 Build 4 基础镜像上的 Build 5/6 节点升级到 Build 7，需先执行此命令。仅适用于已审查的 ubuntu-cc：先结束任务并完全退出客户端；脚本验证签名、离线检查，保存冷备份后切换，失败自动回退。成功后再连接客户端。后续兼容版本可从客户端升级。',
        status.baseUpgradeCommand,
      );
    appendCommand(
      'server-upgrade-command',
      '已接入服务端升级',
      `已完成首次接入的节点使用此命令，目标 Build ${release.build}／协议 ${release.protocol}。每15秒显示进度，等待 SUCCESS 后再连接 CC；已有相同版本会直接提示已安装。忙碌时拒绝升级，保留现有备份、就绪检查和失败回滚。无需重新登录 Claude。`,
      status.upgradeCommand,
    );
    appendCommand(
      'server-bootstrap-command',
      '首次接入',
      '仅尚未接入受管升级的节点使用。安装会短暂重启服务并保存本地备份；如果提示 already installed，请使用上方“已接入服务端升级”命令。',
      status.command,
    );
  }
  return { clear, refresh };
}
