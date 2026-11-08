# ubuntu-cc 原生终端：固定候选的激活与回退

更新：2026-10-23（UTC+08:00）。本文件与独立脚本 `scripts/activate-native-terminal.py` 配套。

## 当前证据与范围

**生产已成功切换为受审原生终端。** 用户在本聊天依次回传候选续测、脚本预检和最终激活的 JSON/PASS；证据来源为用户终端回传，保存在 `docs/evidence/`。

- 生产源码：`ff5743958cb8fd7529b59364d8930168c0e53fc6`。
- 当前镜像：`sha256:75e9c5895bfa232d78905bf1dbf127af173d9f5de88086dc93af80833c8a3b8f`，标签 `cc-desk-tunnel:native-paths-ff5743958cb8`。
- 官方 CLI 2.1.295 / SDK 0.3.286 / 协议 20；聊天审核和原生终端强制审核均启用。
- 受管策略、root 管理的只读挂载、TLS 和控制认证检查通过；账号凭据及路由未改变。
- `cutoverPerformed=true`、`rolledBack=false`；激活过程中真实 Claude/JEV 请求为 0，未打开真实终端。
- 本机一致性备份：`/var/lib/cc-native-terminal-paths-ff5743958cb8/activation/backup`。
- 永久回退脚本：同级的 `activate-native-terminal.py`。
- **客户端切换后实际验收和真实用户消息链路仍待用户正常使用确认。** 用户要求尽量不打扰 Claude，不额外自动发送测试消息或打开真实终端。

独立脚本通过 19 项本地检查（事务模拟和 Node 验证逻辑执行），随后目标 Ubuntu 预检及生产激活均通过。本次新增脚本、文档和证据随部署交接提交纳入仓库；已部署镜像仍对应功能提交 `ff5743958cb8fd7529b59364d8930168c0e53fc6`，不因交接提交而改变。

首次激活曾因空闲计数 0/1 在备份/停服前被拒绝，原生产保持健康；用户随后回传计数 0/0 并重新执行后成功。该阻塞已解决，不能将旧失败当作当前状态。最终证据为 `docs/evidence/native-activation-success-user-report-2026-10-23.json`。

只处理 ubuntu-cc。其他五台、Windows 安装包、stable 通道和账号配置保持既有安排。当前电脑就是远端 Windows 宿主机 DESKTOP-MB2PIGK / TOPC，六台 VM 都运行在这里。

以下预检/激活步骤保留为本次实施说明，**本次均已完成，不例行重复执行**。若以后需要回退，应重新确认当时空闲并使用已保留的回退脚本。

## 预检流程（本次已完成）

将脚本传到 Ubuntu 的 `/tmp/cc-native-activate.py`，先核对交付的 SHA256，再执行：

```bash
sudo python3 /tmp/cc-native-activate.py --check
```

预检只在候选状态目录下写入准备文件和报告，不停止或切换生产。无需提前断开客户端。
它校验目标节点候选结果、完整镜像 ID、当前生产身份、现有节点配置、官方受管策略、
root 文件权限、只读挂载，以及 staged Compose 仅改变镜像和受管目录挂载。
候选策略检查使用无网络、只读根文件系统的临时容器，不挂载生产账号或会话目录。
配置文件包含现有审核节点凭据，仅保存在 root 管理的私有状态目录中。
随后通过本机健康/TLS及控制连接认证检查当前服务，不发送真实消息、继续、压缩、
终端打开或审核请求；仅执行官方 CLI 的 `--version`。

预期报告包含 `preflightPassed=true`、`productionUnchanged=true`、`cutoverPerformed=false`。
状态及诊断位于 `/var/lib/cc-native-terminal-paths-ff5743958cb8/activation/`。
诊断可能含 Docker 配置或凭据，只可按需提取已脱敏内容，不要直接回传原始 inspect、备份或完整诊断。

## 激活流程（本次已完成；以后操作须重新确认当时空闲）

预检通过后，向用户确认节点当前空闲、连接此节点的全部客户端已断开。
其他时间的空闲确认不适用。未得到本次确认前，不执行以下命令：

```bash
sudo python3 /tmp/cc-native-activate.py --activate --idle-confirmed
```

脚本再次检查 SQLite 活动运行及本机 8787 端口的已建立连接；发现忙碌时不切换。
健康检查的瞬时 TCP 连接也可能令此保守检查拒绝；应检查原因，不能移除空闲保护。

切换仅在本机留一致性备份，位置为状态目录下的 `activation/backup/`。
先停止已空闲节点，备份完整数据和原配置，再替换已验收镜像、追加
`PROXY_NATIVE_TERMINAL_REVIEW=1`，并在原 Compose 中添加只读 `/etc/claude-code` 挂载。
该目录包含从候选取出的受管策略和既有审核节点配置的 root 管理副本。
原 `/data/config/moderation-node.json` 保留原状，不重新签发节点身份。
受管目录位于 root 私有父目录下，容器内目录可遍历，文件 root 所有且不可由服务用户写入。

不安装依赖，不重建镜像，不更新 SDK，不重新登录 Claude，不改变代理、出口、遥测或重试设置。
启动后检查健康、协议 20、TLS、控制认证、CLI/SDK 版本、受管策略、只读挂载及原配置保留情况。
这些检查不打开真实终端，不发送 Claude/JEV 请求。

若备份阶段失败，重启原容器；若配置切换后失败，尝试自动回退到原聊天审核镜像。
自动回退仍可能受到磁盘/Docker/配置冲突等实际故障阻碍；以回退结果和实际健康为准。
失败时保留备份和诊断，不删除历史、不放宽审核，也不直接反复执行激活命令。
已有切换备份时激活会拒绝覆盖，重试须先检查上次阶段。

## 手动回退

回退前同样需要用户当时的空闲及客户端断开确认：

```bash
sudo python3 /var/lib/cc-native-terminal-paths-ff5743958cb8/activation/activate-native-terminal.py --rollback --idle-confirmed
```

回退验证备份配置校验和，只恢复本次管理的镜像设置、终端 opt-in 与受管挂载。
保留数据目录、原聊天审核配置、切换后新增的历史、用户文件及其他配置变更；不会自动解压旧数据备份。
若本次管理的设置被其他管理员改写，会在停止服务前拒绝猜测合并。
完整数据归档仅供明确安排后的灾难恢复使用，脚本不自动用它覆盖用户新数据。

## 客户端验收与边界

激活 PASS 仍不代表真实用户消息链路验收。由用户正常使用时核对原历史、设备、统计、
文件查看及受审终端界面；真实 Claude/JEV 消息测试由用户另行安排。
直接调用的自定义提示命令/技能展开仍阻断；`/compact` 走独立审核。
每批历史审核和已有聊天门禁可能重复调用 JEV，增加用量及延迟；没有分类器零误判/零漏判承诺。
不把普通外部文件、图片、工具输出或宿主机管理员访问当作已全面隔离。

## 本地检查

```bash
python3 scripts/test-activate-native-terminal.py
```

19 项检查包含正常切换、归档失败、部分配置写入失败、容器重建后缺失、
新服务验证失败、备份损坏、回退冲突、活动客户端/运行，以及保留新增用户数据。
验证契约检查需要 Node 24：PATH 中存在 node，或设置 `CC_NATIVE_TEST_NODE` 为实际可执行文件路径。
这些模拟不会访问网络或 Docker；目标 Ubuntu 的真实只读预检已由用户执行并回传通过；生产激活已通过，客户端界面及真实消息链路仍待用户正常使用确认。
