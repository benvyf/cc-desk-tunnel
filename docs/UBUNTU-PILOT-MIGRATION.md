# ubuntu-cc 协议 20 单节点迁移

2026-10-23，香港时间。`ubuntu-cc` 已完成备份及生产协议 20 切换，本地认证和独立公网健康检查通过；客户端连接及历史读取已确认，恢复设备 ID 并交付剩余验收步骤后，用户回报“暂时没问题”。记录为本轮试用暂未发现问题，各项未逐一确认。其他五台未迁移，模型测试继续暂停。

用户随后要求先核实 Claude 网络和账号风险再继续。已确认本人自用、CLI 主文件一致、持久配置不变，并解释三份 CC 源码和 Docker 空值表示的差异；在检查范围内未发现本次升级新增 Claude 联网或账号风控风险的证据，建议恢复非模型客户端验收，模型测试仍暂停。实际出口未验证，也没有“保证不触发账号风控”的结论；详见 [网络与账号风险记录](CLAUDE-NETWORK-RISK-2026-10-23.md)。

## 当前生产结果

用户执行固定版本 `7856fea23357ce310822f5864d1b3ff60ef922b2` 的切换脚本并回传 PASS：`cutoverPerformed:true`、`rolledBack:false`、`backupVerified:true`。实际运行镜像为 `sha256:e3275f6f27d5a39b1468123573930285d68cbbcada741b76eefbc7692ab5a553`；服务端协议 20、WebSocket 认证成功，证书指纹和三项流量开关未变，关键服务配置、provider 和证书/私钥文件校验未变。

2026-10-23 11:41:42（香港时间），当前开发电脑独立检查公网 `74.82.201.214:8443`：在发送 HTTP 前验证固定证书 SHA256，随后 `/health` 返回 `status:ok`、`protocolVersion:20`、`adapter:claude-code`。公网检查不携带令牌，未调用模型。本地证据为 `artifacts/server-pilot-4a39bc3/public-post-cutover.json`；用户回传切换结果另存该目录 `production-cutover-reported.json`。本地基线文件保留原协议 19 记录。

用户在风险核对后回报“cc已经链接上”，随后截图确认“定制构建 2 · pilot · 协议 20”，并明确“消息都能查看”。因此客户端连接、正式构建身份及历史消息读取记为用户确认通过；统计、普通工作区文件读取及原生终端显示/关闭尚待回报。

截图同时显示旧 `DESKTOP-FG28DJA` 会话在“其他设备”下且离线。已核实当前 Windows hostname 仍为 `DESKTOP-FG28DJA`，但独立验收 user-data-dir 中的 `settings.json` 生成了与原 `%APPDATA%/CC Desk Tunnel/settings.json` 不同的 deviceId；客户端将身份保存在基础配置目录，并按该 ID 判断会话是否属于本机。用户确认完全退出后，已执行本地脚本，将验收配置的 deviceId 恢复为这台电脑的原 ID，并验证其他配置字段未变；旧验收 deviceId 已单独备份，原配置及服务端会话未修改。客户端未由开发工具重新启动，归属显示仍待用户重开确认。另一台 `DESKTOP-DCTMR82` 不应冒充本机或批量接管。

用户随后询问仅连接 CC 是否会联系 Claude。源码确认：原生模式连接后自动发送 `account.status`，服务端调用官方 CLI 的 `auth status --json`；首次显示空闲会话并加载历史后还会自动刷新 `session.status`，可能启动无用户提示词的官方 CLI/SDK 状态初始化。因此连接和浏览历史不能视为完全不联系 Anthropic；登录、额度等辅助联网与提交聊天模型请求需要区分。此前脚本记录的 `modelRequests:0` 不代表 Anthropic 网络包为零，用户 GUI 操作期间未抓包。已向用户说明，用户随后要求继续；已交付重开客户端及设备归属、统计、文件、终端检查步骤，仍要求不发送聊天消息或输入终端命令。

用户最新回报“暂时没问题”，没有报告设备或功能异常，但未逐项说明上述检查结果；不能据此补记每项正式通过或实际模型出口已验证。当前单节点保留试点，下一步优先安排现有一致回滚备份的离机副本，再决定模型测试和其他节点迁移；不因这次笼统反馈直接推广 stable。

完整回滚备份在节点 `/var/lib/cc-desk-tunnel-pilot-4a39bc3/production-backup/`；这是同盘备份，离机副本仍待安排。回滚命令见后文。剩余客户端项目使用独立 user-data-dir 的真实 Windows build 2 核对，保持模型测试暂停。客户端验收通过前不扩展到其他五台或 stable 通道。

## 已确认基线

用户从目标终端回传：主机 `ubuntu-cc`，IP `172.28.149.26/20`，原容器 `cc-desk-tunnel-ba938975-proxy-1`，镜像标签 `cc-desk-tunnel:local`，已运行约 24 小时且 healthy。根磁盘 29 GB、可用 13 GB。当前开发电脑的 SSH 连接被关闭，管理操作通过远端 Windows TOPC 打开的 Ubuntu SSH 终端进行；不要将 TCP 端口可连接当作 SSH 已认证。

2026-10-23 11:14 公网检查：`74.82.201.214:8443` 的证书 SHA256 与既有固定指纹一致，`/health` 返回 ok、protocolVersion 19、claude-code。检查未发送服务令牌或模型请求。

VPS 仅约 1 GB 内存，运行七个既有业务容器，不在其上构建 CC 镜像。Linux 镜像构建和隔离验证放在试点 Ubuntu。

## 已准备制品

与 Windows build 2 相同的源码提交：`4a39bc35008707366949496f9219e9b68c8d0856`。

- 本地：`artifacts/server-pilot-4a39bc3/cc-desk-tunnel-server-4a39bc3.tar.gz`，大小 `1504265` 字节。
- SHA256：`01c437d136ca9a2533f9fbdd9f76afc41d94ecb4bfddc7be83dc9fe599623fd6`。
- VPS 私有副本：`/root/.cc-update-admin/release-input/`，包含归档、hash 和制品证据。
- 归档包含预构建 Web UI、服务端及 Docker 生命周期文件，源码清洁、协议 20；路径检查未发现本机凭据和开发依赖。源包构建成功不代表 Linux 镜像或生产迁移已通过。

## 已完成：隔离验证过程

执行仓库的 `scripts/prepare-ubuntu-pilot.sh`，该脚本只支持 root 在 `ubuntu-cc` 上运行。下载后先核对该次交付的脚本 SHA256，再执行。它从 GitHub 获取固定源码提交，不覆盖 `/opt/cc-desk-tunnel`。

| 项目 | 隔离位置 |
| --- | --- |
| 源码 | `/opt/cc-desk-tunnel-pilot-4a39bc3` |
| 镜像 | `cc-desk-tunnel:pilot-4a39bc3` |
| Compose 项目 | `cc-pilot-4a39bc3` |
| 私有状态及日志 | `/var/lib/cc-desk-tunnel-pilot-4a39bc3`，root 专用 |
| 测试数据 | 上述目录下 `data/`，新生成临时令牌及证书 |
| 测试端口 | `127.0.0.1:18787`，不新增公网入口 |

脚本构建并启动新的测试容器，核对 HTTPS 健康和协议 20 认证、协议 19 拒绝、两个旧更新命令拒绝，再强制重建测试容器，确认文件、配置、证书保留，`/data/program` 中的模拟旧程序没有被执行。原生产容器的 ID、镜像 ID 和启动时间必须保持一致。成功后停止测试容器，保留镜像和证据；失败保留日志并停止已启动的测试容器，不自动修改或回滚生产服务。

用户只回传进度、`result.json` 或指定的脱敏错误；不要发送 `production-*.inspect.json`、部署配置、service.env、provider.json 或备份归档，它们可能含真实凭据。构建日志在 `build.log`，首次构建需要下载依赖，不是模型调用。

首次交付的验证请求编号误用了命令名，已修正为协议要求的 UUID，并使用实际 authSchema/commandSchema 校验消息格式。实际首次构建在读取 `/tmp/install-linux.sh` 时失败：准备脚本的 umask 077 使 root 克隆的源码只有 root 可读，Docker COPY 保留该权限后普通构建用户读不到。修正版仅对独立的公开源码 checkout 增加读取/目录遍历权限；私有 STATE 目录不改变。

修正版支持 `--resume`：核对原生产快照及固定源码后，从 Docker 缓存继续未完成的构建；若镜像已完成则复用镜像。尚未初始化时创建隔离配置，已初始化则复用隔离数据继续验证，不重新克隆。缺少原始快照或固定源码时拒绝恢复。下载并校验修正版后再使用此参数，勿修改旧脚本的 hash 来跳过校验。当时生产服务未切换，后续已完成生产切换，见当前生产结果。

## 实际隔离验收结果

用户在 `ubuntu-cc` 执行 `9836f017e90ca0b79c6be830c56c58f4fbd8bee3` 版本准备脚本并回传 PASS。固定源码 `4a39bc3` 的 Linux 镜像构建完成；协议 20 认证、协议 19 拒绝、旧更新命令拒绝、容器重建、持久数据及忽略下载程序检查全部通过。测试容器已停止，生产容器未变，模型请求为 0，未执行生产切换。真实镜像 ID 保存在节点私有 `image-id.txt`，尚待脱敏盘点回传。

下一步执行只读脚本 `scripts/inspect-ubuntu-pilot.py`，只输出镜像 ID、Compose 路径及项目、挂载、端口、版本、三项流量开关和 OTEL 变量名、磁盘用量。它不会输出完整环境变量、配置内容、令牌或证书私钥，不会停止服务。脱敏报告保存为私有状态目录下 `preflight-sanitized.json`，可回传；其余 inspect、配置及备份仍不可回传。任务是否空闲需要操作者确认，健康状态不代表没有运行任务。

## 已完成：生产盘点及切换准备

2026-10-23 11:32 香港时间的脱敏盘点已回传：

- 旧镜像：`sha256:8b9d684a84664ad27a7d97d808a8a8a057940b6ca3f5c080d6bc2182792d2390`，应用 0.3.5，原生 CLI 2.1.293。
- 已验收新镜像：`sha256:e3275f6f27d5a39b1468123573930285d68cbbcada741b76eefbc7692ab5a553`。
- 原 Compose 项目 `cc-desk-tunnel-ba938975`；配置 `/opt/cc-desk-tunnel/.local/docker.env`；Compose 文件 `/opt/cc-desk-tunnel/deploy/docker/compose.yaml`。
- 唯一挂载 `/srv/cc-desk-tunnel:/data`，端口 `0.0.0.0:8787`。数据占用 255819776 字节，旧镜像 1902422321 字节，可用空间 8824700928 字节。
- 三项独立流量开关均为 1，未发现总禁用开关或 service/container 层的 OTEL 变量；这不表示运行时没有内部 OTEL 采集。
- 用户在切换前已确认“此节点无任务，旧客户端已断开”。随后回传切换 PASS，见当前生产结果。

切换脚本为 `scripts/cutover-ubuntu-pilot.py --idle-confirmed`，只适用上述固定节点和镜像。先保存旧镜像及完整源码/配置，再停止单个服务并完整归档数据，核验归档可读性、SHA256 和关键配置；随后更新原 docker.env 中的镜像设置，以原 Compose 项目、配置和挂载启动已验收镜像，禁止构建或拉取。检查本地 TLS 固定指纹、协议 20、WebSocket 认证及三项开关，未调用模型。生产中的历史、统计、文件和终端仍需 Windows 客户端验收。

备份放在 `/var/lib/cc-desk-tunnel-pilot-4a39bc3/production-backup/`，root-only，包含 `old-image.tar`、`source-config.tar`、`data.tar`、`docker.env` 和校验清单。数据备份失败时重启原容器；开始切换后失败则核验备份、停止/移除该服务容器，将切换后的数据重命名保留，再恢复备份数据和旧镜像，检查协议 19。不会删除新版本数据，也不会修改其他节点及中转配置。

脚本执行时将自身保存到节点私有状态目录，之后手动回滚命令是：

```bash
sudo python3 /var/lib/cc-desk-tunnel-pilot-4a39bc3/cutover.py --rollback
```

回滚只应在节点空闲、客户端断开时执行。新数据保留在 `/srv/cc-desk-tunnel.failed-pilot-<时间戳>`，原程序源码不改变，旧配置中的镜像设置固定到备份镜像标签，避免标签漂移。私有日志为 `cutover-private.log`；不要直接回传日志、配置或备份内容。本次备份在同一磁盘，离机副本尚待安排。

本机用临时目录、实际文件归档和模拟 Docker 验证了成功切换、认证失败恢复旧快照并保留新数据、数据备份失败重启旧容器三个核心流程。没有本机 Linux/Docker 运行环境，实际生产结果以目标节点执行及公网/客户端验收为准。

## 隔离通过后的切换顺序

1. 从原容器确认实际挂载目录、镜像 ID、Compose 配置、版本及原生 CLI 版本；记录三项 Claude 流量开关和 OTEL 配置，不输出密钥。必要时在隔离环境先验证已有数据的兼容性。
2. 确认该节点没有运行任务，关闭旧客户端到此节点的连接，再安排短暂维护窗口。其他五台继续使用旧客户端。
3. 保存旧镜像为独立归档，备份源码及部署配置；停止这一个 CC 容器后，对 `/srv/cc-desk-tunnel` 做一致备份并校验。备份放数据目录之外，root-only；保留证书、令牌、账号、历史、工作区、统计及 OTEL 配置。另行安排离机副本；同盘备份不等于独立灾难恢复备份。
4. 原程序目录和原配置保留；使用已经验收的独立镜像，以原 Compose 项目、端口和数据挂载替换该节点容器，不执行首次初始化，不重置令牌/证书，不调整中转隧道。使用固定镜像 tag，避免升级流程自动重建为另一个制品。切换前需要记录确切回滚命令和恢复位置。
5. 核对节点健康为协议 20、证书指纹未变、历史和统计可见，并用独立目录、独立 user-data-dir 的 Windows build 2 验证连接、文件及终端通道；暂不调用模型。
6. 不通过时停止新容器，恢复匹配的旧镜像、部署配置及一致数据快照，验证协议 19 和原连接；不要将已经被新版本修改的数据直接交给旧程序当作完整回滚。

单节点验收通过后再决定其他五台迁移、stable 推广和模型测试。更新索引的续期仍按 [build 2 发布记录](UPDATE-CLIENT-BUILD-2.md) 单独维护。
