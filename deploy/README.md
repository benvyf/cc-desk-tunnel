# Linux Docker 部署

> 本 Fork 关闭在线更新。当前修改尚未发布为定制安装包，下述发布安装流程仅在配套定制构建发布后适用；现有生产环境迁移须先核对版本、备份并试点。详见[定制维护说明](../docs/MANAGED-UPDATES.md)。

Ubuntu amd64 优先；arm64 为实验性支持。CI 覆盖两种架构的构建及部署自测，新改动以对应 CI 结果为准；arm64 尚无真实账号会话验收。官方 Claude Code、Agent SDK、PTY 同容器；不改 Claude 本体、不加入执行 MCP。容器有可写层和较完整工具环境，不是只读沙箱；以 uid 1000 普通用户运行，无宿主 Docker socket、特权模式或宿主项目挂载。

## 准备

当前受审安装流程在 `codex/vps-update-channel` 分支。先取该分支源码，再运行本地安装器；旧 release 程序包和 `main` 链接不会因开发分支提交而自动更新：

```sh
git clone --single-branch --branch codex/vps-update-channel https://github.com/benvyf/cc-desk-tunnel.git
cd cc-desk-tunnel
sudo bash deploy/install.sh
```

安装前由现有管理中心管理员为新节点提供独立 JSON（`endpoint`、`nodeId`、`token`）。已有节点复用其既有配置，不重新签发。安装器只询问本机 JSON 文件路径，校验并导入，不打印密钥、不自动注册节点，也不调用 Claude/JEV。该输入为必填项，不能一路回车跳过审核。

目前不提供现成镜像：镜像在你的服务器上从程序包构建，首次需要几分钟，期间联网下载系统包、Node.js、Claude Code 和 npm 依赖。

也可以手动准备：从项目的 GitHub 发布页取同一版本的三个文件：服务端程序包 `cc-desk-tunnel-server-X.Y.Z.tar.gz`、Windows 安装包 `CC-Desk-Tunnel-Setup-X.Y.Z-x64.exe` 和 `SHA256SUMS`。放到 VPS 的同一目录后先校验，再把程序包解压到专用程序目录：

```sh
sha256sum -c SHA256SUMS
sudo mkdir -p /opt/cc-desk-tunnel
sudo tar -xzf cc-desk-tunnel-server-X.Y.Z.tar.gz -C /opt/cc-desk-tunnel
cd /opt/cc-desk-tunnel
```

程序包不含秘密、Windows UI、开发测试和依赖。也可以自己打包：本机运行 `npm run package:server`，或直接使用完整仓库。

交互安装：依次询问公网地址、入口方式、端口、数据目录、独立节点 JSON 文件路径和服务凭据，然后构建并启动。节点配置缺失/无效时不启动。已有部署须先完成下面的受管接入，升级不会自动签发身份或修改账号。

```sh
sudo bash deploy/install.sh
```

升级与客户端分发：

```sh
# 原地升级：解包新的源码包覆盖程序目录，重建镜像并替换容器；数据、账号和配置不动
sudo bash deploy/manage.sh upgrade --from /path/cc-desk-tunnel-server.tar.gz
# 更换服务凭据（留空则随机生成）并重启；已保存旧凭据的客户端需重新填写
sudo bash deploy/manage.sh token
# 随时重看汇总
sudo bash deploy/manage.sh summary
```

### 管理员统一更新

客户端不提供更新按钮、在线下载或升级服务端操作；版本不匹配时请联系管理员安装配套定制版。`manage.sh client` 与 `manage.sh release-token` 已停用。服务端忽略旧的发布跟踪配置，不向客户端分发安装包，`/client/installer` 不提供下载。

管理员从审核过的固定提交构建匹配的客户端与服务端，备份后试点，再用上面的 `manage.sh upgrade --from` 重建镜像。客户端安装包通过管理员渠道手工分发。容器始终运行镜像内 `/app`，不会执行数据目录 `program/` 的历史在线更新；这些旧文件会保留。回滚应使用已保存的定制镜像与配套客户端。

同时进行的运行和终端有上限，默认按服务器内存估算（每个约占 300 MB，1 GB 内存的服务器是 2 个）。要改就在 `config/service.env` 里加 `PROXY_MAX_RUNS='数量'` 并重启服务。

电脑断线后，它的任务在服务端继续，等它连回来；离线超过 5 分钟才停止。要改这个时间就加 `PROXY_GRACE_SECONDS='秒数'`（0 到 3600，0 表示断线即停止）并重启服务。

需要脚本化或分步执行时仍可用参数形式：

```sh
sudo bash deploy/install.sh init --host VPS_IP --moderation-config /secure/this-node.json
# 上一步打印数据目录；默认 sudo 安装为 /srv/cc-desk-tunnel
# 按需编辑 <数据目录>/config/provider.json，不把 API key 放进镜像。
sudo bash deploy/manage.sh build
sudo bash deploy/manage.sh up
sudo bash deploy/manage.sh connection
```

`install.sh` 只检查 Docker / Compose 等依赖，缺少或 Docker 未运行时给出安装命令后退出；不安装系统软件，不修改 nginx、防火墙、SSH 或账号。首次构建联网下载系统包、固定 Node / CLI 和锁定 npm 依赖；非 JS 编译安装，node-pty 在镜像构建阶段准备。Node 24 原生执行 TypeScript；发行检查仍必须 typecheck。

默认一个公网 TCP 端口：WSS / HTTPS `8787`，登录、对话和执行通道都经它。运维 SSH 遵循服务器已有端口。云防火墙与主机策略自行放行，**不需要 UDP 或公开 Windows / Linux 随机 SSH 端口**。从 0.2.9 及更早版本升级的部署原先还放行了 `7000`，不再使用，可以去掉；用 `manage.sh upgrade` 升级时容器也不再发布它。Docker 发布端口可能绕过 UFW 的常规 INPUT 规则，应采用云安全组或 Docker 对应防火墙策略，不把启用 UFW 当成已限制发布端口。

nginx 模式下服务按 `X-Real-IP` 区分来源地址做登录限速，请保留示例里的这一行。

## 三种 TLS 入口

初始化只能进行一次，避免覆盖长期上下文或秘密；另一个安装用 `PROXY_DEPLOY_CONFIG=/绝对路径/docker.env`，并选独立数据目录 / 端口。

```sh
# 无域名：自签证书，客户端明确固定 SHA256 指纹
sudo bash deploy/manage.sh init --host VPS_IP --data /srv/cc-desk-tunnel \
  --moderation-config /secure/this-node.json

# 真实域名证书：检查证书/私钥配对、到期及域名，复制进私有数据目录
sudo bash deploy/manage.sh init --host proxy.example.com --mode certificate \
  --cert /path/fullchain.pem --key /path/privkey.pem --data /srv/cc-desk-tunnel \
  --moderation-config /secure/this-node.json

# 已有 nginx：只将上游 HTTP 发布至宿主回环，WSS 证书由 nginx 管理
sudo bash deploy/manage.sh init --host proxy.example.com --mode nginx \
  --url wss://proxy.example.com/ws --data /srv/cc-desk-tunnel \
  --moderation-config /secure/this-node.json
```

nginx 的配置步骤、检查方法和常见问题见[用 nginx 反代](nginx.md)。容器内监听 `0.0.0.0:8787` 是为 Docker bridge 接入，不是宿主公网 HTTP。同一 Docker 网络的可信边界也需考虑；不要把未知容器接入此网络。nginx 模式默认宿主 `127.0.0.1:8787`、公网 `443`；已有 nginx 入口端口由用户决定。不自动申请证书或改现有 nginx。

客户端填 `connection` 输出的 URL / token。自签模式填指纹；真实可信 CA 或 nginx 域名证书将指纹留空，使用 CA、有效期和主机名校验。私有 CA 可选择明确指纹；指纹模式不额外验证有效期 / 域名，首次信任应由可信 SSH 渠道获得。没有任何关闭验证且不校验指纹的模式。

执行通道与控制连接用同一个地址和同一张证书，没有单独的隧道证书；每次连接另有随机生成的通道密钥，经已验证的 WSS 下发。自签证书默认一年。

## 固定 CLI 与强制审核

默认安装固定官方原生 Claude Code **2.1.295**，x64/arm64 分别校验仓库中固定的 SHA512；不修改官方二进制。版本检查只执行 `--version`，安装和服务启动均不发送模型输入。SDK 保持锁文件中的 0.3.286，本次不升级 SDK。

初始化会将受管策略和已有节点 JSON 放入 `<数据目录>/.managed/claude-code/`。父目录 root 私有，配置 root 所有，Compose 将该目录只读挂载到 `/etc/claude-code`；普通服务用户不能改写。Docker 启动入口同时验证真实只读挂载、管理员文件权限、四个必要 command hook 和节点配置。

新部署默认同时启用聊天审核和受审原生终端，普通 `service.env` 中删除变量、设置 `PROXY_NATIVE_TERMINAL_REVIEW=0` 或切换 adapter 不能关闭生产镜像的受管入口。节点配置只做本地格式校验，不自动发消息验证注册；未注册/被撤销或审核服务异常时，消息仍按门禁拒绝。直接调用的自定义提示命令/技能展开仍暂时阻断。

新初始化默认设置 `DISABLE_TELEMETRY=1`、`DISABLE_ERROR_REPORTING=1`、`DISABLE_AUTOUPDATER=1`，保留额度查询；不设置非必要流量总开关。导入既有节点配置时保留原有其他环境、提供方、OAuth、账号及路由。

### 既有部署接入

本次不会自动重启/迁移现有节点。需要迁移时先确认空闲、客户端断开并做本机一致性备份，然后：

```sh
sudo bash deploy/manage.sh stop
# 复用本节点既有 JSON，不能拿其他节点配置代替，也不需要重新签发
sudo bash deploy/manage.sh moderation-config /secure/this-node-existing.json
# 导入只备份并更新受管配置，不自动启动；确认目标镜像后再 up 或 upgrade
sudo bash deploy/manage.sh upgrade
```

`moderation-config` 检测到本项目容器仍运行时拒绝操作；失败不自动停止服务。配置写入失败恢复本次改动，备份位于 `.managed/backups/`。`up`、`restart`、`setup` 和 `upgrade` 在配置不完整时拒绝启动/升级。

root 受管文件位于持久数据目录中，常规 `backup` 自动包含。`restore` 只适用于新初始化且未运行的部署，会重新应用可信策略、恢复节点配置所有权和审核开关；不会自动发消息或登录账号。

## 模型与可写空间

`config/provider.json` 是官方 Claude settings 结构，初始 `{}`；API 环境配置可写入 `env` 中的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`，使用提供方正式支持的接口。不要将 key 放进命令行、Git 或截图。使用订阅登录还是 API key，以及是否符合提供方条款，由使用者自行确认。

持久数据位于指定 `--data`：

- `home/`：原生 Claude 账号 / 配置 / 上下文、用户安装工具及缓存。
- `state/`：代理 SQLite / WAL、原生工作目录、连接期临时 SSH 配置。
- `workspace/`：Linux 辅助工作空间。
- `config/`、`tls/`：服务秘密、模型配置和两套 TLS 身份。
- `.managed/`：root 管理的审核策略、独立节点凭据及配置备份，包含在常规数据备份中。

预装 Git / SSH / rsync、Node / npm、Python / pip / venv、GCC / make、curl / wget、jq / rg、文本编辑器、压缩工具、SQLite、网络与进程工具。普通用户可往 `home` / `workspace` / `/tmp` 写入、建 venv 或用户级安装 npm 包；不能直接 apt 安装系统软件。需要更多系统组件时扩展 Dockerfile。容器 root 文件层也并非全盘只读，但升级重建会丢弃其中临时修改；重要工具和记忆须存 `/data`。默认项目任务仍通过 Windows SSH。

## 运维

```sh
sudo bash deploy/manage.sh status
sudo bash deploy/manage.sh logs
sudo bash deploy/manage.sh stop
sudo bash deploy/manage.sh up
sudo bash deploy/manage.sh restart
sudo bash deploy/manage.sh upgrade
sudo bash deploy/manage.sh backup /secure/backup.tar.gz
sudo bash deploy/manage.sh uninstall
```

Compose 崩溃 / 主机重启恢复，`tini -g` 管理信号与孤儿进程；停止给代理 30 秒正常回收，强杀则 Docker 回收容器中全部进程。日志上限 3 × 10MB。健康检查不发模型请求，也不是深度外部可用性探测；Docker 不会仅因 unhealthy 自动重启进程。

升级先构建新镜像，构建失败不停止旧容器；成功后替换容器，数据保留。上线前先 backup；可将旧镜像另行打 tag，并在私有 `docker.env` 中设置 `PROXY_IMAGE`，`up` 切回。镜像可 `docker save` 后在 VPS `docker load`，无需 VPS 重建；当前无公共镜像注册表，不假称可直接 pull 产品镜像。

仅导入镜像时，使用 `deploy/compose.yml` 作为基础文件，同时保留 `deploy/docker/reviewed.compose.yaml` 和管理脚本。设置 `PROXY_COMPOSE_FILE=/绝对路径/deploy/compose.yml` 后使用 `manage.sh up/status/stop`，脚本依据初始化生成的 `MANAGED_CONFIG_DIR` 自动叠加只读受管挂载。手工调用 Compose 时必须同时传入这两个 `-f` 文件及原私有 env；遗漏受管挂载或以读写方式挂载会导致新镜像拒绝启动。镜像导入升级仍需使用匹配的版本与策略，不用 `manage.sh build` 重建已导入镜像。

镜像构建后，`sudo bash deploy/test.sh` 可运行不调用模型的隔离部署回归；占用测试端口 19871..19874，创建临时数据并在结束时回收。不会改既有服务；测试数据被删除，不用来测试生产数据。

备份先停服务保证 SQLite / WAL 与原生数据一致，结束后恢复之前运行状态；排除临时 SSH 凭据、缓存和升级时留下的会话库副本（`state/backups`）。备份**含 token、API / 账号秘密、证书私钥和历史**，权限 0600，需安全离线保存。恢复仅允许已 stop 且长期数据为空的新初始化部署：

```sh
sudo bash deploy/manage.sh restore /secure/backup.tar.gz
# 核对 config/service.env 中 public host 与证书设置，docker.env 中 URL / 端口。
sudo bash deploy/manage.sh up
```

恢复只接受自己可信的备份，不执行未知归档。卸载仅删除容器与网络，保留数据、配置、镜像和宿主 Docker；要永久删除数据必须由用户确认准确目录后单独删除，不自动卸载其他程序依赖的 Docker。

自签续期：`manage.sh renew`，重启后重新交付客户端指纹。真实证书续期：`manage.sh certificate FULLCHAIN KEY`；可在既有 ACME deploy hook 中调用。nginx 的证书由既有 ACME / nginx 续期流程处理，无需重建容器。替换会断开在途会话，先结束任务。

原生开发部署仍有 `scripts/install-linux.sh` 与 `scripts/deploy-linux.mjs`，目前为普通用户 nohup 调试方式，不是生产部署方案。
