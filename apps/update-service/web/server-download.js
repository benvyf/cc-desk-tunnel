export const SERVER_RELEASE_PROMPT = `请在 CC Space 仓库 https://github.com/benvyf/cc-desk-tunnel.git 中，基于我指定的最新已审查源码，更新 VPS CC 管理中心提供的 Linux 服务端安装包及升级指令，并完成验证、签名发布和续期登记。默认只发布软件包和指令，Ubuntu 节点由我自行升级；不要创建、重试或执行节点安装任务。

请先阅读当前 AGENTS.md、docs/UPDATE-RELEASE-RULES.md、DEVELOPMENT-HANDOFF.md 和最新发行/故障记录。以实时状态为准，不照抄文档里的旧 Build、源码提交、路径或脚本。具备已有授权的执行环境时完成以下工作；缺少源码、VPS 访问或验证条件时明确说明阻塞项，不把方案或模拟结果说成已发布、已安装。

1. 核对 Git 工作区、主分支、待发布源码、VPS 运行文件清单、公开签名索引、当前最大 Build、精确续期配置、各节点实际上报的版本及作业状态。区分“已发布”“节点已安装”“用户反馈成功”和“独立实机验证”，不把它们混为一谈。保留线上其他功能，只修改本次直接相关文件；管理中心可能有独立 overlay，不能用主分支整体覆盖。

2. 使用新且未发布的 Build、干净已提交源码、独立制品和版本化脚本路径，不原位替换旧包或已发布脚本。版本、协议、运行级别、依赖锁和归档描述符必须一致；精确准入已核实的旧版本，不放宽签名或兼容性校验。CLI、SDK、账号、审核策略与模型出口继续留在 Ubuntu，不顺带升级它们；不要调用真实模型、登录或查询生产额度。

3. 特别防止 Build 19 的旧错误：当时签名目标是 19，但迁移脚本内部硬编码下载了 18。下载 URL、文件名、Build、临时目录和候选镜像标签必须取自一致的、已验签并确认的目标身份。测试必须断言实际请求地址，不能用“任意 URL 都返回同一假包”的 mock 掩盖错版。实际运行新签名迁移脚本自身的 HTTP 下载、验签和严格解包，核对它再次下载的版本、大小、SHA256 和清单；只验签索引、只检查 agent 选中了脚本都不够。

4. 升级默认入口必须包含准备流程，不能依赖用户另传 --cleanup：持有更新锁，先核对节点、签名、基线、未完成记录及任务状态；按引用保护清理 APT 下载缓存、未使用构建缓存、无运行/停止容器及回退引用的旧候选镜像、无引用旧解包文件。保留当前程序、必要上一套回退、账号、项目、会话、管理员策略和诊断日志。不使用全局 system/volume prune、强制删镜像、盲删备份或重写备份摘要。

5. 下载、解包、构建前先评估空间；构建和离线预检后再清缓存并复核冷备份/恢复预算；冻结切换前再次确认。空间不足要在停止原服务前给出可用量、需要量和缺口，不降低阈值、不跳过备份。历史备份退役必须先验证当前必要回退，成功后仅按既有规则轮转。

6. 在 Ubuntu/Linux 隔离环境完成真实构建、官方运行时/依赖完整性与真实 PTY 预检，并测试清理失败、空间不足、忙碌拒绝、空闲连接自动断开和失败恢复等关键路径。模拟与实机结果分开记录。若旧基础镜像报 CRC、tar 头、摘要异常或重复读取结果不同，保留日志并检查完整 OCI 清单中的所有层，不只看构建日志显示的几层；不关闭校验或反复重试到成功。读取成功一次不等于故障修复；结合宿主机存储事件和备份状况处理，再决定能否继续。

7. 只有验签、环境、空间和离线预检通过，且没有运行/等待审批任务或占用中的原生终端，才进入短切换：阻止重连和新任务，受控断开空闲客户端，正常停止服务，生成并校验冷备份，再切换、健康检查，失败按既有流程恢复。不要强杀用户工作，也不要要求逐个关闭空闲客户端。对恢复点、镜像和策略的处理必须可追溯；不擅自用旧会话库覆盖新数据。

8. 发布前检查两端续期服务及节点作业，暂停相关续期 timer，确认没有正在运行的续期/发布；备份需要改动的程序、配置和索引。优先沿用当前通道，不自动扩大 stable 或节点授权范围。必须重启管理中心时先准备可回退候选、校验一致冷备份，健康失败只按既有程序回退策略处理，保留新业务数据。

9. 发布后验证公网真实签名索引、完整下载大小/SHA256、归档内安装入口，以及管理中心当前 agent/生成命令实际选中新版本。登记精确 expectedRelease、新源码及独立制品路径，强制续期并运行真实 systemd 单元，恢复 timer，核对未改通道和节点作业。确认 Windows 客户端配套兼容及独立更新提示/获取入口；若需要客户端配套发行，明确范围并遵守客户端发布门槛，不伪造协议或隐藏更新提示。

10. 在源码中提交并按本次授权推送修复、发行身份和脱敏证据，保留已发布制品及续期引用的源码。最后给出新 Build、源码提交、下载/签名/续期核验结果、管理中心获取新指令的位置、实际与模拟验收范围及未完成事项。明确“更新发布与升级指令完成”不代表“已替用户安装 Ubuntu”。复制给 GPT 的内容不得包含临时安装码、节点令牌、签名私钥或 Claude 凭据。`;

export function setupServerDownload({ request, element, notice }) {
  const root = document.getElementById('server-download');
  let generation = 0;
  function clear() {
    generation++;
    root.replaceChildren();
  }
  async function refresh() {
    const active = ++generation;
    root.replaceChildren();
    const guide = element('section');
    const heading = element('h3', '更新服务端发布指令 · 给 GPT 的提示词');
    const copyPrompt = element('button', '复制升级指令更新提示词', 'quiet');
    copyPrompt.type = 'button';
    const details = element('details');
    const label = element('label', '可复用的服务端发布提示词');
    label.htmlFor = 'server-release-prompt';
    const prompt = element('textarea');
    prompt.id = 'server-release-prompt';
    prompt.readOnly = true;
    prompt.rows = 16;
    prompt.spellcheck = false;
    prompt.value = SERVER_RELEASE_PROMPT;
    details.append(element('summary', '查看完整提示词'), label, prompt);
    copyPrompt.addEventListener('click', async () => {
      if (active !== generation) return;
      try {
        await navigator.clipboard.writeText(prompt.value);
        if (active === generation) notice('已复制提示词，可粘贴给 GPT 更新服务端包和升级指令。');
      } catch {
        if (active !== generation) return;
        details.open = true;
        prompt.focus();
        prompt.select();
        notice('提示词已选中，请按 Ctrl+C。');
      }
    });
    guide.append(
      heading,
      element(
        'p',
        '用于下次更新管理中心提供的服务端包和升级指令。包含默认清理、备份回退及错版下载验证要求；默认由你自行执行 Ubuntu 升级。',
        'muted',
      ),
      copyPrompt,
      details,
    );
    root.append(guide);
    const status = await request('/server');
    if (active !== generation) return;
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
        '包含当前服务端、配套 Web 和部署文件。服务端升级适用于已接入受管更新、且每台虚拟机仅运行一个 CC 服务容器的兼容节点；首次接入仍仅适用于已审查的第一台 ubuntu-cc。执行前结束任务；普通升级和首次接入还需完全退出所有 CC 连接（包括托盘），下方基础镜像升级命令会自动断开客户端。升级期间保持 Ubuntu 终端打开。',
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
                : id === 'server-base-upgrade-command'
                  ? '请在已核对的 ubuntu-cc、02 或 03 控制台执行。'
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
        '清理并升级基础镜像（ubuntu-cc / 02 / 03）',
        release.build === 9
          ? '适用于 ubuntu-cc、02、03 已核实的 Build 4/5/8 基础环境。校验签名和原程序完整性、清理未使用的构建缓存、检查空间、构建并离线预检后，确认无任务，自动断开客户端、冷备份，再一起切换 Build 9 镜像与新审核策略。只审核聊天/终端新发送的消息，不再读取历史；账号、原会话、TLS、旧镜像、原策略及离线回滚保留。04、05、06 本轮不升级。请先结束运行或等待中的任务，保持此控制台打开；成功后重新连接，无需执行下方普通升级。已安装相同版本会直接验证并返回。'
          : `完整命令：识别已核对的 ubuntu-cc、ubuntu-cc-02 或 ubuntu-cc-03 → 清理未使用的 Docker 构建缓存 → 检查空间 → 校验或构建镜像 → 离线预检 → 确认无运行任务 → 强制断开客户端并阻止重连 → 冷备份 → 升级到 Build ${release.build}。第一台支持已核对的旧 Build 4 基础镜像，02、03 支持已核对的 Build 5 基础镜像；其他设备或镜像不匹配会停止。已升级到 Build ${release.build} 无需执行。保留账号数据、容器、正式镜像和回滚备份，不自动删除安装介质。空间不足会停止；失败时按脚本提示回退。执行前结束任务（包括等待中的任务）；无需手动退出客户端，脚本会断开连接并在升级期间阻止重连。保留账号数据，升级失败会尝试恢复原服务；保持 Ubuntu 终端打开，成功后重新连接，无需再执行普通升级。`,
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
