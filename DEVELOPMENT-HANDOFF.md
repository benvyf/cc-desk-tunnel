# CC 管理中心开发交接（2026-10-24，香港时间）

这是本项目当前工作状态与跨电脑续做的权威入口。旧文档中的 Build 2/3、未接入客户端、没有续期等陈述属于历史阶段；遇到冲突以本文件及 VPS 实际签名索引为准。生产状态是检查时的快照，后续 revision／有效期会自动续期。

### 2026-10-24 review修复：策略更新后的缓存顺序

review离线复现512条缓存已满、修改策略、重新审核最旧文本后，该条目因Map.set覆盖不更新顺序而被下一条新内容淘汰，重复文本多付一次审核。修复只在替换条目前delete再set，保持最新审核结果的淘汰顺序。扩展原有容量回归，先证实旧代码失败，再验证新代码复用：模拟审核调用由515恢复预期514。15项去重/HTTP相关测试及TypeScript通过，没有真实Claude/JEV请求。仅发布控制中心模块，不改Ubuntu、审核策略或发布索引；原生hook修复仍待镜像维护。

控制中心已从干净源码c47de22a27d6483a062d94ac9cd4b8cf0fc2d714上线，48个运行文件中只改变moderation-nodes.ts；正式包独立导入通过。备份/var/backups/cc-update-service/jev-cache-order-20261024T092101Z，旧运行目录/opt/cc-update-service.previous-jev-cache-order-c47de22。配置、管理员登录、审核策略、发布索引、续期登记及节点清单均保持，两timer active。实际生产Claude/JEV验收请求为0。详见[缓存顺序修复发布](docs/evidence/jev-cache-order-production-2026-10-24.json)。

### 2026-10-24 JEV小范围费用优化

用户要求优先采用改动小、收益明确的两项修复。控制中心扩展为同节点/会话/策略下完整相同文本跨入口复用，最多512份近期内容并刷新命中顺序，保留A→B→A的通过结果；拒绝、错误、请求ID冲突、内容/策略/会话隔离保持。原生hook按tool_use_id和实际文本避免transcript与tool_calls重复拼接，不遗漏不同hook内容或权限反馈。9项去重/hook测试、27项HTTP/审核回归、18项打包/发布/兼容性测试通过（另2项平台/浏览器测试跳过），TypeScript通过；没有真实Claude/JEV请求。

发布检查发现native-moderation-hook.ts属于现有COMPATIBILITY_PATHS保护闭包，普通程序更新不能替换。保持校验与已发布Linux Build3不变，只部署控制中心优化；hook修复源码与测试准备完成，待后续管理员镜像维护。本环境没有ubuntu-cc的SSH管理入口，不能宣称已应用该节点修复，也不应发一个现有节点无法普通升级的Build4。完整边界见[审核说明](docs/MODERATION-NODE-GATE.md)和[后续设计](docs/JEV-COST-REPAIR-DESIGN.md)。当前工作区并行桌面样式改动保留，不纳入本次提交。

控制中心已从干净源码e2b5fdfddb90acf5f9a43e57d0a5e55916bd13bc上线，正式包SHA256为7e8fe1c2c4d4554d00942d55f8e93503006a5dfa669dabb976f1287d542c88e2，48文件中仅审核节点模块和审核说明变化。备份/var/backups/cc-update-service/jev-small-20261024T091422Z；配置、管理员登录、审核策略、发布索引、续期登记及现有节点均保持，两timer active。实际运行包独立导入和干净checkout类型检查通过，真实Claude/JEV调用为0。Windows Build7/Linux Build3不变，Ubuntu未操作。部署证据见[小范围修复发布](docs/evidence/jev-small-production-2026-10-24.json)。

### 2026-10-24 原生终端重复JEV调用

用户报告一个问题产生多次审核。只读VPS事件元数据确认，香港时间16:14–16:19的8条记录中有5次相同16161字节文本和2次相同16169字节文本，均为同一会话；工具批次hook生成新请求ID导致原有去重失效。控制中心新增原生会话最近通过内容的摘要/策略revision缓存及同时请求合并，不缓存拒绝或错误；新内容、节点/会话/策略变化重新审核。普通CC输入仍按请求审核，入口与终端审查内容不同可能各触发一次。见[审核说明](docs/MODERATION-NODE-GATE.md)。13项相关测试通过，合成JEV提供方证明一次输入加8次相同工具hook只记1次JEV请求；未调用真实Claude/JEV。工作区并行中的客户端界面改动由用户保留，本次不纳入提交或发布。

已从干净源码 `ac37b523fcd468f59127a973b8edf3bad4bc56ad` 发布控制中心，运行清单仍48文件，仅审核节点模块与说明变化。备份 `/var/backups/cc-update-service/native-review-dedup-20261024T082429Z`，旧运行目录 `/opt/cc-update-service.previous-native-review-dedup-ac37b52`。原审核策略/阈值、管理员与节点凭据、账号监控、发布索引与续期登记均保留，两timer active；Ubuntu和客户端无需升级。干净源码TypeScript及实际运行包导入通过，未为验收发真实请求。后续正常使用观察缓存效果，服务重启后首次内容会再审一次。证据见 [重复审核修复发布](docs/evidence/native-review-dedup-2026-10-24.json)。

### 2026-10-24 空白 Ubuntu 一条命令部署

后续用户要求 review，发现并修复三项故障恢复/可用性问题：配置中断残留阻止重试、兑换响应丢失后无法同机恢复、错误安装码触发全局失败计数后阻断正确码。新流程在请求前落盘随机安装标识，安装码只绑定该实例，同机可在有效期内重领相同配置，服务器只存摘要；配置通过同文件系统阶段目录和原子发布支持中断恢复，已配置的镜像/凭据直接复用。六项 Linux 测试及新增 HTTP 故障场景通过；仍未把模拟 Docker 当成完整新 VM 实测。修复后需要重新生成安装命令，旧命令固定了旧安装脚本摘要。

review 修复已从干净源码 `1c67bf1d5bac6dc6a9f304377ae3a5c4ce41e593` 上线，运行清单48文件。备份 `/var/backups/cc-update-service/fresh-ubuntu-20261024T074649Z`，旧运行目录 `/opt/cc-update-service.previous-fresh-review-1c67bf1`。公网修复资源核对通过，已有节点、凭据、审核策略、发布索引与续期登记不变，两timer active。原生产安装注册表保持原字节，未签发测试安装码、未改Ubuntu节点、未请求Claude/JEV。证据见 [review 发布与故障回归](docs/evidence/fresh-ubuntu-review-2026-10-24.json)。

新增控制中心“客户端更新 → 新建 Ubuntu 一键部署”，目标空白 Ubuntu 24.04 LTS x64。管理员输入独立节点名称生成十分钟、单次兑换命令；Ubuntu 自动安装 Docker、验证当前签名 Linux Build、静态验证固定官方运行时、构建镜像并完成无网络无账号 sentinel 就绪检查，配置独立监控/审核凭据及只读策略挂载，最终显示客户端连接信息。官方 Claude 登录由用户之后执行本机 helper。原首台接入白名单、已发布 Windows Build 7／Linux Build 3 及现有节点不变。

新增动态注册表保存在管理服务 private 目录，只存凭据摘要，兼容原静态节点配置；重启时先合并节点再打开监控数据库。核心接口、Linux OpenSSL 与模拟安装、真实 Edge 复制/过期/清空/390px、实际运行包导入测试通过。尚无空白 Ubuntu VM 完整联网安装反馈，不把模拟 apt/Docker 流程当成实机成功。使用、重试边界及网络说明见 [新机部署](docs/FRESH-UBUNTU-INSTALL.md)。

控制中心已从干净源码 `75e92b102fd5d28305385031beafdd865aae5477` 打包并上线，运行清单48文件。VPS备份 `/var/backups/cc-update-service/fresh-ubuntu-20261024T073549Z`，旧运行目录 `/opt/cc-update-service.previous-fresh-75e92b1`。公网四项资源与源码字节相同；实际公开 Linux Build 3 的签名、完整归档清单和配套 Web 经新安装器函数验证通过。原配置、管理员凭据、审核策略、节点列表、发布索引、续期登记不变，两timer active；未签发生产测试安装码、未改任何Ubuntu节点、未发Claude/JEV请求。脱敏证据见 [新机入口发布](docs/evidence/fresh-ubuntu-production-2026-10-24.json)。

### 2026-10-24 GitHub 同步完成

用户已授权将最新改动同步到 GitHub，账号编号、服务端账号管理、控制中心升级命令、客户端固定升级入口及发布记录均已推送至 `benvyf/cc-desk-tunnel` 的 `codex/account-monitor-production` 分支。下文各发布快照中的“尚未推送 GitHub”是当时状态，以本节为准；安装包与运行包的源码身份不因后续文档提交改变。工作区原有未跟踪安装目录和历史资料保留本地，未纳入本次推送。

### 2026-10-24 客户端固定服务端升级入口（Windows Build 7 已发布）

用户要求像源项目一样，在客户端升级服务端，即使协议相同也能按 Build 检查。已从干净源码 `fb873003731df95ea34f5078548cd1b668063e60` 构建发布 Windows Build 7／0.3.6／协议20，pilot revision12。连接页固定显示“检查服务端更新”；已连接时“设置 → 关于与更新”和“设置与账号”菜单均有入口，确认断开后关闭隧道并自动检查，本窗口临时保留连接信息，取消确认则保持连接。展示目标版本／Build／协议／SHA256，再确认安装，沿用现有主进程签名、重放保护与服务端备份／就绪／回滚。活动任务或终端时禁用设置入口，其他连接仍由服务端准入拒绝。

新包201081647字节，SHA256 `f44819ed3ba6c9d813ddd3bbead359f8943e626be65bbc31968f9c7edab2e656`；[Windows Build 7 下载](https://api.ghostapi.org/cc-updates/v1/artifacts/7/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe)。Linux仍为Build3，控制中心运行源码仍为 `d63607d…`，均不重发；stable空通道不变，两timer active。Windows续期已登记新源码和精确制品并验证成功。TypeScript、6项React/Edge界面场景、11项相关主进程回归及1项最终EXE/preload/组件关闭测试通过；公网生产公钥验签、完整下载摘要及HEAD/Range通过。未调用真实Claude／JEV／额度接口。用户Windows安装和新入口实机行为尚待反馈，首台Ubuntu先前已回传Build3升级成功，不必重复升级。操作见 [客户端服务端升级](docs/CLIENT-SERVER-UPGRADE.md)，证据见 [Build 7 发布](docs/evidence/client-server-upgrade-build7-2026-10-24.json)。源码完整bundle保存在VPS，本次仍未推送GitHub。

### 2026-10-24 服务端登录、客户端编号（VPS 已上线，首台 Ubuntu 已升级）

用户要求客户端不再管理 Claude 登录、客户端不显示邮箱，控制中心显示编号与邮箱对应；已明确选择在 Ubuntu 终端通过官方 Claude Code 登录。工作区已实现移除客户端登录/退出/授权码入口、服务端拒绝对应远程账号操作、账号身份元数据发送前转为稳定编号（含历史回放），控制中心并列显示/搜索编号和邮箱。编号基于既有完整账号 ID，示例 `CC-7A3F-91C2-6B8D-4E50`，无需新增请求、编号分配服务或数据库迁移。原始监控仍保留邮箱。

后续 review 的两项发布问题已修复：控制中心运行包补入编号依赖；编号解析扩展独立到 `packages/protocol/src/account-display.ts`，保持 `index.ts`、`native-account.ts` 与 Build 2 原始字节一致，旧登录实现保留但账号入口不调用。不修改受管升级白名单和校验规则，可沿用现有程序升级路径；离线回归以已发布 Build 2 摘要为基线，检查模拟新 Build 的兼容性准入、实际运行包完整性及编号往返解析。

review 修复后通过 Node24 TypeScript、前端生产构建、74项相关回归及模拟数据的真实 React/Edge 账号页面检查。随后用户授权“部署上线”：以干净源码 `224d7bcae1e4d1e1f37a8b72bfdb3d48cfacaa6a` 正式构建并部署控制中心，发布 Windows Build 6（pilot revision 11）和 Linux Build 3（pilot revision 5），版本0.3.6／协议20；stable 保持空通道。两套续期登记已更新、timer active。完整制品摘要、公网签名和管理页资源均核验通过；未启动真实 Claude/SDK 会话、JEV 或额度请求。发布详情与证据见 [正式发布记录](docs/ACCOUNT-MODE-RELEASE-2026-10-24.md)。

用户升级客户端后看到“账号编号尚未读取”，随后确认 Ubuntu 执行的是首次接入命令，输出 already installed，因此当时未升级程序。改用受管升级命令后，用户回传 `SUCCESS: Linux Build 3 / protocol 20 is installed and committed.`，确认首台服务端已安装提交 Build 3。Windows 新账号页已经显示，精确客户端构建号未经开发机独立读取；重新连接后编号显示仍待用户反馈。不要重跑首次 bootstrap 或为此重新登录 Claude。VPS 备份 `/var/backups/cc-update-service/account-display-20261024T041203Z`，旧运行目录 `/opt/cc-update-service.previous-account-224d7bc`。本次发布源码及历史提交已保存 VPS Git bundle，尚未推送 GitHub。

用户进一步指出控制中心缺少服务端升级指令。已从源码 `d63607d1401bd84c0d1724488533190913031e64` 部署独立的“已接入服务端升级”与“首次接入”命令，绑定当前发布的精确 Build／协议／摘要，可整行复制并显示进度；过期不提供命令，忙碌不绕过现有准入。仅更新控制中心44文件运行包，不重发 Windows6／Linux3，两套续期登记与签名索引原字节不变，timer active。备份 `/var/backups/cc-update-service/server-upgrade-ui-20261024T060655Z`，旧运行目录 `/opt/cc-update-service.previous-upgrade-ui-d63607d`。14项相关测试通过，1项POSIX权限测试在Windows跳过；TypeScript、真实管理接口合成升级、真实浏览器复制/过期/390px检查、实际运行归档及公网资源核验通过。证据见 [控制中心升级入口部署](docs/evidence/control-center-server-upgrade-2026-10-24.json)。

### 2026-10-24 首台受管接入、正常会话与被动上报成功（当前状态）

用户在 `ubuntu-cc` 执行带进度的首次接入命令后，回传 `Managed server installed. Local readiness passed; no Claude/provider queries made.`，并正常返回 shell。首次受管接入已完成：目标 0.3.6／Linux Build 2／协议 20，安装器通过新容器健康、受管状态及发布描述文件摘要检查后写入 installed.json。此结论依据用户节点安装器成功输出，不是开发机直接 SSH 验收；没有进行真实 Claude／额度／JEV 会话测试。

本次完整冷备份及回滚脚本位于 `/var/lib/cc-server-bootstrap/backup-20261024T030534Z-878b97a3`；离线回滚命令为 `sudo python3 /var/lib/cc-server-bootstrap/backup-20261024T030534Z-878b97a3/rollback.py --rollback /var/lib/cc-server-bootstrap/backup-20261024T030534Z-878b97a3`，仅在需要回滚时使用，当前不执行。保留此前 CLI 异常文件备份及手动中断备份。脱敏证据 `docs/evidence/bootstrap-production-success-2026-10-24.json`。

用户随后确认“已经安装最新的安装包、已经连接上、会话也正常”。这是用户实际使用反馈，未由开发工具主动启动客户端或 Claude 会话，也未独立读取本机客户端构建号。只读核对 VPS 监控缓存于香港时间 2026-10-24 11:14:37 完成：配置节点6、已上报节点1、账号1；首台 `ubuntu-cc` 为 schema 2，identity=identified，邮箱存在，套餐 Claude Pro，quotaStatus=ok，两个额度窗口，已有会话 usage。最新观察香港时间11:13:30，接收11:13:30，额度采集11:13:29。本次读取仅访问 VPS loopback 管理缓存 API，不触发节点或供应商请求，脱敏证据 `docs/evidence/natural-monitor-cache-verification-2026-10-24.json`。

用户在收到管理页核对建议后确认“都正常”。首台的受管安装、用户客户端连接/正常会话、自然被动上报和管理页日常查看基础流程验收通过。此反馈未细分备注保存/刷新持久化，不能扩大为所有边界场景已验收。后续仍需正常使用中确认备注持久化、换号/多节点隔离、未知/过期/错误状态，以及主机重启和后续升级/回滚的实机行为。其余五台继续暂缓，不为填充管理页数据主动调用 Claude／额度／JEV。以下各节保留历史排障过程，旧的“尚未接入/无自然上报”描述以本节为准。

### 2026-10-24 首次接入手动中断与重试准备

官方 CLI 恢复后，用户执行首次受管接入，因终端长时间无输出而按 Ctrl+C，再运行只读诊断。故此前“进程已结束”不能解释为安装自行失败。备份 `/var/lib/cc-server-bootstrap/backup-20261024T025834Z-a7e5958b` 有 `data.tar.gz`、`snapshot-id` 和 `offline-build.log`，无 replacement intent/record/id，也无 installed.json；说明已进入备份后离线构建/验收阶段，尚未记录新容器创建。

用户进一步回传当前容器与原记录的 ID、镜像、名称、Config、HostConfig、Mounts 均一致，网络名称集合一致，running=true、paused=false、health=healthy。因此原服务已恢复，可在保持任务空闲和客户端关闭后重试；无需再运行回滚脚本，也不删除现有备份。只读结果见 `docs/evidence/bootstrap-interruption-recovery-2026-10-24.json`。

本机 `.local/server-bootstrap-next-command.txt` 改为带进度的单行启动命令：保留管理 API 原始启动代码、同一安装器和制品摘要，外层每15秒显示等待时间及 preflight/新备份的文件大小；不读取日志内容，不部署新安装器，也不发起 Claude/JEV/额度请求。本地仅用 sleep/print 合成流程核验进度显示和结束清理。用户随后重试成功，见顶部成功记录；无需重复执行首次接入。

### 2026-10-24 实际 CLI 单字节差异与恢复完成

首台用户重试 bootstrap 后，运行环境校验拒绝继续。只读检查确认 Node v24.21.0、SDK 0.3.286、四个审核 hook、账号数据路径、节点配置格式及只读策略挂载符合要求；实际 CLI 摘要不符。用户节点缓存的官方 2.1.295 包 SHA256 为 `d45a2fa14a7ea0b8ab4f56e502de5893c2b816078c71c4d8ab2e4142148f3d95`，包内文件 SHA256 为 `4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`；容器文件为 `f66a66b89fa1c229ff9edce0065277a2d0897ebd6710f6d3e8b722c6e1d9ec2e`。用户完整逐字节比对证实仅 offset 194437468 从官方 `9f` 变为 `f5`，两文件均为 256113848 字节。VPS 独立重现此改动得到相同摘要，差异位于 ELF `.bun` 节；原因未知，不能认定恶意或无害，也不能再称实际节点 CLI 已验真且原样。

已准备 `scripts/restore-reviewed-claude-cli.py`：只接受本次异常摘要，验证本地官方缓存包和完整官方文件，在暂停后的空闲检查通过后，备份异常文件、原子替换完整同版本文件并核验 root/0755 与 SHA256；替换后校验失败会恢复旧文件，普通异常、Ctrl+C/SIGTERM 会尝试解除暂停。强制 SIGKILL 或宿主故障无法执行清理，运行时会显示手工解除暂停命令。它不执行 Claude，不读取账号文件、不改审核策略、SDK、网络配置或安装器白名单；备份位于 `/var/lib/cc-cli-official-restore/`。

在 VPS 无网络、无账号挂载、入口仅 `/bin/sleep` 的临时 Docker overlay 容器验证 5/5 通过：真实完整官方文件恢复与备份、重复执行无修改、activeRun 拒绝并解除暂停、替换后注入失败原子回滚、暂存时中断保留旧文件并解除暂停。证据 `docs/evidence/cli-restoration-integration-2026-10-24.json`。本机 `.local/cli-official-restore-commands.txt` 提供两条独立单行命令，避免终端长行截断及 heredoc 粘贴问题；第二条校验源码摘要后执行。

**用户已在真实 Ubuntu 执行 CLI 恢复成功。** 用户回传 `SUCCESS`、官方完整 SHA256 `4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`、root/0755 校验通过及 `containerRunning: true`，暂停已解除；备份 `/var/lib/cc-cli-official-restore/20261024T025442Z-hi6k94xg`。此为用户节点执行输出，非开发机直接连接验收。差异原因仍未知。生产恢复证据见 `docs/evidence/cli-production-restoration-2026-10-24.json`。后续受管接入亦已成功，见顶部记录。

接入前已只读核对管理中心认证 API 和公网 bootstrap：Linux Build 2 发布有效，制品摘要为 `19f4a60538b1fea67a9f4438d13c4cf75a821bed0b9973d93af7d5c69d852f11`，安装器摘要为 `270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0`。本机 `.local/server-bootstrap-next-command.txt` 保留管理 API 原始启动代码，增加本地进度显示并编码为单行，避免 heredoc/多行粘贴。CLI 恢复和受管接入是两次独立执行，现均有用户成功回传；未新增启动 Claude、JEV 或额度请求。

### 2026-10-24 首次接入挂载修复补充

用户执行首台 bootstrap 时，在停服前收到 `Expected data and read-only policy bind mounts.`。回传只读 inspect 确认容器仍 running，数据源为 `/srv/cc-desk-tunnel`，审核源为历史正式激活目录 `/var/lib/cc-native-terminal-paths-ff5743958cb8/activation/managed`，后者正确地只读挂载到容器内 `/etc/claude-code`。安装器此前只允许宿主源 `/etc/claude-code`，遗漏了这个已审查的历史路径。

修复提交 `0fcc03ecd2954720e647bbedf2cd995ebbc0bc50` 只增加该精确路径的兼容，仍拒绝可写审核目录、未知路径及额外挂载；克隆容器时保留原 HostConfig。回归先复现失败再通过，Linux Python bootstrap 16/16 通过。VPS 管理中心已从该提交的干净源码运行包部署，42 文件 inventory 校验通过，公开安装器 SHA256 为 `270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0`，管理 API 生成命令已绑定新摘要。发布的 Windows Build 5、Linux Build 2、三个已核对的通道索引、生产配置和 CURRENT-RELEASE 均未改动；两套续期继续使用这些不可变制品对应的源码。

备份 `/var/backups/cc-update-service/bootstrap-policy-0fcc03e-20261024T022330Z`；旧运行目录 `/opt/cc-update-service.previous-bootstrap-policy-0fcc03e`。脱敏部署证据见 `docs/evidence/bootstrap-policy-mount-fix-2026-10-24.json`。下文较早的“VPS 运行源码同为 9ab5f49”属于修复前快照，当前管理中心源码以本补充为准，安装包源码身份仍为 9ab5f49。首台尚待用户刷新管理页、重新复制命令并执行成功；旧命令绑定旧安装器摘要，不能复用。本轮未启动真实 Claude、JEV 或额度查询。

## 1. 用户要实现什么

把 CC Desk Tunnel 定制维护版做成完整管理系统。管理中心统一登录、顶部导航，每个功能独立页面与地址：账号监控、客户端更新、内容审核。页面刷新及前进后退保留当前功能，只加载当前页面所需数据。

核心目标是后续管理很多 Claude Pro/Max 账号，主要通过 Claude Code 使用。账号采用完整邮箱＋自定义备注；区分账号、Ubuntu 节点、Windows 客户端，能看清每个账号当前身份、额度和数据时效。账号监控复用 Ubuntu CC 服务端正常使用时已经得到的结果，推送一份到 VPS；VPS 页面只读自己的缓存。

另一个已授权目标是把最新定制客户端和完整配套服务端包放到 VPS。客户端发现服务端协议不匹配时提供“升级配套服务端”，显示精确目标版本、Build 和摘要，用户确认后才升级；空闲检查、冷备份、就绪检查和失败回滚必须保留。旧服务端第一次需要在 Ubuntu 控制台运行接入命令；以后支持兼容的程序升级。

长期约束：尽可能不打扰 Claude。开发、验收、页面刷新、安装包下载不得为了填数据主动查询 Claude／额度／JEV，不启动真实原生终端，不升级官方 CLI/SDK，不重新登录账号或切换网络出口。本轮只用了合成账号数据、loopback 和隔离 Docker；CLI sentinel 证明没有启动 Claude。此设计减少额外请求，不是对第三方账号政策或风控结果的保证。

## 2. 机器与数据流

```text
用户自己的 Windows 电脑：安装 CC 桌面客户端，代码和工具留在本机
    ↕ WSS 控制和临时 SSH 执行隧道
远端 Windows 宿主机：通过 UU 远程管理，里面运行 Ubuntu 虚拟机
    └─ 第一台 Ubuntu ubuntu-cc：Docker 中的 CC 服务端＋官方 Claude Code
           ├─ 正常登录／用量事件 → 被动同步模块 → HTTPS 上报 VPS 缓存
           └─ 原有审核 hook → VPS 审核功能（与账号监控独立）
VPS api.ghostapi.org：管理中心、审核、账号缓存、签名更新与下载分发
```

“宿主机”是运行虚拟机的那台远端 Windows，不是 Ubuntu，也不是 VPS。目前没有可直接操作 Ubuntu 的 SSH 地址；用户通过 UU → 远端 Windows → 虚拟机控制台操作。CC 的业务隧道不等于 Ubuntu SSH 管理入口。

账号同步只上报白名单字段：账号稳定 ID、邮箱、订阅类型、组织、认证方式、provider；身份状态；额度状态／窗口利用率／重置时间；正常会话已有的 usage；观察时间及 VPS 接收时间。自定义备注保存在 VPS，按账号关联多个节点快照。没有观察到的字段必须显示未知或不可用，不能把缺失当成 0。usage 是已观察到的会话／run 统计，不是完整官方账单。配置最多 64 个节点；同节点 ID 多生产者冲突检测、账号档案分页／自动过期删除、完整换号流水、逐字段采样台账尚未实现，规模化前需逐项评估。

不上传 Claude OAuth token、Cookie、密码、私钥或完整聊天。上报身份使用独立节点鉴权；VPS 发布公钥是安装包验签用途，不用于登录 Claude。实际字段契约见 `packages/protocol/src/account-monitor.ts`。

## 3. 现在做到哪

| 部分 | 当前状态与边界 |
| --- | --- |
| VPS 管理中心 | 已上线，独立账号监控／客户端更新／内容审核页面，统一顶部导航与登录 |
| 签名下载 | pilot 客户端 Build 7、Linux 服务端 Build 3；版本 0.3.6，协议 20；stable 保持空通道；用户已回传首台 Build 3 升级成功 |
| 续期 | Windows 与 Linux 各有独立 systemd timer，登记精确源码／制品身份；不会自动推进 Build 或同步上游 |
| 被动监控代码 | schema 2、邮箱／备注、身份／额度时效、重试与缓存已实现 |
| 第一台监控接入 | 用户安装成功，VPS 缓存已收到 ubuntu-cc 自然上报：1账号、1节点，身份/邮箱/Pro套餐、额度和会话usage有数据；备份见下文 |
| 第一台服务端受管升级接入 | 用户实机首次 bootstrap 成功，Build 2／协议 20，本地就绪通过；用户确认客户端连接和会话正常，主机重启及后续升级/回滚尚待验收 |
| 本机桌面安装 | 用户确认已安装最新包并成功连接、正常会话；开发工具未自动安装或启动客户端，未独立读取实际客户端构建号 |
| 其余五台 Ubuntu | 暂缓，只有首台有 Claude 账号；未自动接入、登录、迁移或批量升级 |
| 大规模账号运营 | 基础字段与账号／节点关系已铺好；真实多账号持续数据、容量和日常操作验收尚待后续 |

“账号监控一键接入”和“配套服务端升级首次接入”是两个独立入口，不能混为一次安装。登录 CC 只有在原有流程确实获取到身份／额度结果后才可能产生同步；登录管理中心或反复点刷新只读 VPS，不强制查询 Claude。

## 4. 源码身份、下载与本轮 review

完整工作分支：`codex/account-monitor-production`。GitHub 仓库：<https://github.com/benvyf/cc-desk-tunnel.git>。本轮检查远端尚无此工作分支，普通 clone 不能取得当前全部工作；请使用交接包内的 `cc-desk-tunnel-source.bundle`。交接 bundle 包含提交后的代码、文档与全部祖先，不包含未提交文件和依赖。

重要提交：

- `3ff4c5c`：合并 GitHub 更新、管理页和账号监控工作。
- `57bf058`、`7f5ad39`：服务端签名契约／监督升级、桌面确认升级。
- `b05f6644105cbc56e0b50b93101cf51a860b9931`：历史 Windows Build 4／Linux Build 1 的不可变发布源码。
- `a16ba6f8418425fd5ada9e51928016235b6a3bb4`：历史 VPS 长摘要移动端换行修复。
- `ee92b32`：本轮审查前的发布记录基线。
- `9ab5f49f8155076ae5d7eacb33d9e369da4e2199`：本轮四项修复及 Windows Build 5／Linux Build 2 发布源码。
- 文档提交在上述发布源码之后；以恢复后的 `git log -5 --oneline` 查看，不把文档 HEAD 误当成安装包源码身份。

已修复并经独立复审：

1. 中断解包留下半成品，导致相同发布永久不能重试。现在写到同级临时目录，校验、持久化后原子重命名；旧残缺缓存隔离保留，不无界删除。
2. 安装连接丢失时误认上次失败／回滚为本次结果。准备阶段在网络等待前清理旧终态；客户端收到确认响应或看到精确目标的进行中状态后，才接受失败／回滚。无法关联的状态继续等待，超时提示人工核对，不重复安装。
3. 首次接入和监督程序固定 Build 1。现在按签名 release 与镜像内身份校验 Build，baseline 也来自该身份；公钥、源站、现有运行环境与持久化校验仍保留。
4. Docker 已创建替换容器但 ID 尚未落盘时中断，无法恢复。创建前持久化 intent，按原容器 ID、目标镜像及随机 label 三项精确核对认领；未知容器拒绝删除。

本轮验证：Node 24 全量 498 项，466 通过、32 平台／可选跳过、0 失败；TypeScript、仓库检查和 diff 检查通过。Python bootstrap 15 项（本机 14 通过、1 POSIX 跳过），监控安装器 5 通过。新增回归先确认原实现失败，再验证修复通过。实际最终安装包、Linux 权限与上线验证见随交接包附带的脱敏证据。

### 先前 Build 5／2 发布与验证快照（历史；当前发布见顶部）

- Windows x64 Build 5：201080092 字节，SHA256 `301822128518e76af90e6ca62e5fc3ac07786b4ca4a4df5fe8d3f6158670206c`；pilot revision 10，有效期至 `2026-10-26T19:49:08.623Z`。
- Linux x64 Build 2：1563938 字节，SHA256 `19f4a60538b1fea67a9f4438d13c4cf75a821bed0b9973d93af7d5c69d852f11`；descriptor SHA256 `3d81089396d4a2820adcca021f10a5d66fc58120037344a78fda26fc48e1f626`；pilot revision 4，有效期至 `2026-11-06T19:49:06.726Z`。
- [Windows 完整包](https://api.ghostapi.org/cc-updates/v1/artifacts/5/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe)；[Linux 完整程序包](https://api.ghostapi.org/cc-updates/server/v1/artifacts/2/linux-x64/cc-desk-tunnel-server-0.3.6-build2.tar.gz)。实时状态以管理中心和签名索引为准，不能仅根据历史直链安装。
- VPS 运行源码同为 `9ab5f49f8155076ae5d7eacb33d9e369da4e2199`，42 个运行文件哈希一致、root 所有、0644，配置及 `state.sqlite`／`moderation.sqlite`／`monitor.sqlite` 逻辑内容和私有身份在部署时保持一致。
- 本轮运行／冷数据备份 `/var/backups/cc-update-service/server-distribution-20261023T194726Z`；旧运行目录 `/opt/cc-update-service.previous-server-distribution-20261023T194726Z`。续期配置与 loader 备份 `/root/.cc-update-admin/automation-backups/2026-10-23T19-49-05-831Z`。
- 注册状态 `complete`；Windows／Linux 两套强制续期、systemd 沙箱执行成功，两 timer 和管理服务／Nginx active。候选数 0，stable 空通道原始字节未变。
- 最终 Windows 完整包真正启动／preload／随包组件关闭测试通过。Linux 最终归档真正 COPY 进入镜像后，以 UID 1000、只读、无网络、无账号挂载、限制资源运行：状态 Build 2／协议 20、health、SIGTERM 和零 CLI sentinel 检查通过。Python bootstrap 在 Linux 15/15 通过，补足本机 POSIX 跳过项。
- 公开签名与下载大小／摘要、最新 bootstrap hash、管理页复制命令、退出清除、390px 无横向溢出、零页面错误均通过。浏览器使用真实线上公开资源与 Linux 下载，管理 API 元数据通过只读 SSH 在 VPS 内认证后提供给浏览器，令牌未进入开发电脑或浏览器；不等于最终生产浏览器真实密码登录演练。
- 最终只读核对：配置节点 6、已上报节点 0、账号 0；首台 Ubuntu bootstrap 未执行。未进行真实 Claude／额度／JEV 验收调用。
- 发布辅助脚本也经独立复审：暂停双 timer 后明确拒绝 `activating` 等 oneshot 运行状态；登记失败持久化 `REGISTRATION-STATUS.json` 并停止 timer 待修复，不错误恢复旧 expectedRelease。本轮实际登记完成，未遗留恢复任务。
- 本地本轮原始脱敏证据位于 `.local/review-release/production-evidence/verification.json`、`vps-verification.json`、`linux-package-smoke.log`、`.local/client-build-5-integrity.json` 和 `.local/review-*.log`；交接 ZIP 的 `evidence/` 收录必要副本。

## 5. 换电脑如何恢复

把完整交接 ZIP 复制到新电脑，解压到普通用户可写的开发目录。不要只复制这个 Markdown。包内包含本文件、完整 Git bundle、SHA256SUMS、脱敏证据、精确本次发布辅助脚本快照；不包含生产凭据、账号资料、node_modules、vendor、VPS 数据库或安装包。

在 PowerShell 中先核对 `SHA256SUMS.txt` 内每个文件的 SHA256，再恢复（路径按新电脑选择）：

```powershell
python ./verify-handoff.py
Get-FileHash ./cc-desk-tunnel-source.bundle -Algorithm SHA256
git clone --branch codex/account-monitor-production ./cc-desk-tunnel-source.bundle ./cc-desk-tunnel
Set-Location ./cc-desk-tunnel
git bundle verify ../cc-desk-tunnel-source.bundle
git remote set-url origin https://github.com/benvyf/cc-desk-tunnel.git
git status --short
git log -5 --oneline
```

`git bundle verify` 放在恢复后的 Git 仓库内执行，避免不同 Git 版本要求当前目录在仓库内的差异。恢复应干净、包含本轮修复和本文档。完整 bundle 可离线 clone。联网 fetch 远端更新后先比较再合入，不能 reset 到较旧的 GitHub 分支。仅在用户授权的发布／推送安排下推进远端，不强推。

准备 Node **24.x**、npm、Git、Python 3、Windows PowerShell **7（pwsh）**；不要依赖旧电脑 `C:/Users/benben/...npm-cache/...node.exe` 的路径。根目录 `package.json` 要求 `>=24 <25`；`node --version` 必须先确认。旧机器系统 Node 25 不是本项目的运行基线。

```powershell
node --version
npm ci
npm run doctor
npm run typecheck
npm run check
npm test
python apps/update-service/test/server-bootstrap.test.py
python apps/update-service/test/monitor-installer.test.py
npm run build
```

Python 测试文件名含点，使用上面的直接执行方式；不要用普通 unittest discover 后误把“0 tests”当通过。Windows 上 POSIX 测试跳过，在 Linux 隔离环境补验。网络受限时先解决正常依赖获取，不为完成测试改动锁文件或换版本。

打 Windows 完整包前运行 `npm run prepare:windows:package` 获取有固定摘要的 OpenSSH/PowerShell，再运行 `npm run package:windows`；它会执行真正打包程序的离线 smoke。平台组件不在 Git。Linux 程序包用 `node scripts/package-server.mjs <绝对输出路径>`，管理中心运行包用 `node scripts/package-update-service.mjs <绝对输出路径>`。发布包要求干净且已提交的源码；修改后应使用新 Build，不能覆盖已发布同 Build。

旧 `.local/` 目录不随源码恢复。里面有历史 fixture、junction 和身份固定的临时部署脚本，不能整目录上传、不能递归清理未知 junction。交接包 `operations/` 是本轮脚本快照，包含精确旧／新提交前提；只供复核／改造，不要直接重跑已经完成的发布或历史激活。

## 6. VPS 运维与发布位置

- 域名：<https://api.ghostapi.org>；更新页 `/cc-updates/admin/updates`，其余页面地址以顶部导航为准。
- VPS：`74.82.201.214`，SSH ED25519 指纹 `SHA256:Q7TmQOsYoY+V4agj8p2bwHx5qICS3gBqt0NIan/38to`，保留主机校验。
- 运行目录 `/opt/cc-update-service`；Node `/opt/cc-update-runtime/bin/node`；监听 loopback 8817；systemd `cc-update-service`。
- 配置 `/etc/cc-update-service/config.json`；数据 `/srv/cc-update-service`；Nginx snippet `/etc/nginx/snippets/cc-update-service.conf`。
- 生产发布身份 `/root/.cc-update-admin/identity-public.json`；签名私钥 `signing/managed-vps-2026-10-23.pem`；管理令牌 `access/admin-token.txt`。私钥和令牌始终留在 VPS，不粘贴到聊天／Git／浏览器测试。
- Windows 续期配置 `/root/.cc-update-admin/automation/config.json`，loader `/opt/cc-update-renewer/scripts/renew-managed-index.mjs`，单元 `cc-update-renew.service/timer`。
- Linux 续期配置 `/root/.cc-update-admin/server-renewal.json`，入口 `scripts/managed-server-publication.mjs renew CONFIG [--force]`，单元 `cc-server-index-renew.service/timer`。
- 当前精确制品登记 `/root/.cc-update-admin/CURRENT-RELEASE.json`；源码、输入包与证据在该目录下 `source-build-5/`、`release-input/`、`release-output/`，最终交接包也备份在 `release-input/`。

新电脑需要已有授权的 SSH 身份。当前电脑使用 `C:/Users/benben/.ssh/vps_bandwagon_ed25519`，这是本机路径，不是公共下载地址；不能从 Git 或 ZIP 获得私钥。可由用户另行配置新电脑合法管理身份；不必下载 VPS 发布私钥。

发布流程：先干净提交、离线验证、打包；传精确 Git bundle、EXE、Linux archive 与模板到 VPS；在新的干净源码目录签名和发布。Windows 用 `scripts/publish-managed-update.mjs`，Linux 用 `scripts/managed-server-publication.mjs sign/publish`。发布前暂停两套 timer，并核实没有续期服务正在运行；备份运行目录、配置、单元、Nginx 和一致的数据快照。先 pilot，保留 stable 原始字节。

发布后必须登记新的 expectedRelease、干净源码和独立制品路径，更新续期 loader（如有变更），强制续期并测试 systemd 沙箱，然后恢复两个 timer。不可只改页面显示或把自动续期配置留在旧 Build。确认候选完成后清理候选记录，保留公开制品；核对签名、版本、完整下载大小和 hash、bootstrap hash、运行文件 inventory、服务／timer 状态及 stable 字节不变。

失败恢复程序与配置，不把旧业务数据库覆盖回去。程序升级回滚保留候选写入的新业务数据，冷备份留作人工恢复依据。VPS 同机备份不等于异地灾难恢复。

## 7. 第一台 Ubuntu 的准确现场信息

- hostname `ubuntu-cc`；容器 `cc-desk-tunnel-ba938975-proxy-1`。
- 实际容器业务程序 0.3.6／协议 20，官方 CLI 2.1.295，SDK 0.3.286。
- 宿主路径 `/opt/cc-desk-tunnel` 是旧 0.3.5／协议 19，**不能用该旧目录重建覆盖现有容器**。
- Docker 29.9.1／API 1.56；进程检查用 `docker top CONTAINER -eo pid,args`。缺 PID 的 `-eo comm` 曾导致 daemon HTTP 500。
- 数据 `/srv/cc-desk-tunnel`，管理员策略 `/etc/claude-code` 只读挂载。
- 用户已执行的被动监控备份：`/var/lib/cc-monitor-install/backup-20261023T164726Z`。该目录 `rollback.py` 是监控安装回滚，与服务端 bootstrap 回滚不同。
- 受管服务端首次 bootstrap 已成功，Build 2／协议 20。备份 `/var/lib/cc-server-bootstrap/backup-20261024T030534Z-878b97a3`；后续程序升级走 CC 确认流程，首次接入无需重跑。bootstrap 仍仅支持已审查的首台 profile。
- 已审查官方 CLI 原始 SHA256：`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`。原试点没有 CLI stamp，脚本按原始字节、root 所有权和权限验证，不执行 `claude --version`。

首次 bootstrap 会验证已有源码、运行环境和只读审核策略，隔离无网预检后保存冷备份，替换容器时保留配置／挂载／网络／数据。既有镜像可能派生于此前审核镜像，不得因为与老 base ID 不同就直接替换。依赖、持久化、审核 hook 或固定运行环境不兼容时明确要求人工镜像升级；程序更新不自动升级 CLI／SDK。监督程序属于不可变镜像，修它需要对应镜像／首次接入，不能把普通业务程序包视为自动更新了旧镜像监督器。

## 8. 接下来按什么顺序做

1. 在新电脑恢复交接 bundle，先看工作树和本文档，核对线上签名索引／CURRENT-RELEASE；不要重复历史发布。
2. VPS 已发布 Windows Build 7／Linux Build 3；用户已回传首台服务端升级成功。安装Build7后，连接页与“设置 → 关于与更新”可按Build检查服务端；控制中心仍可复制专用命令。保留现有备份，无需重复升级服务端、重跑接入、再次恢复CLI或重新登录。等待用户反馈账号编号和新客户端升级入口的正常使用。
3. 用户已确认最新完整桌面包连接、会话及管理页查看正常；VPS 已核对到首台真实自然上报的身份/邮箱/套餐、额度及usage，基础流程验收通过。后续在正常使用中核对备注持久化、缓存滞后、退出、未知和错误状态，尚未观察到的状态标为待验证，不为演示主动调用第三方接口。
4. 在首台完成真实安装、重启、正常使用及失败恢复演练后，再决定其他节点接入；每台先核实真实镜像／源码／版本，独立审核与上报身份，不共用秘密、不自动登录 Claude。
5. 多账号后续工作：在真实自然样本下核验同账号多节点归并、换号后归属、未知字段和额度缓存隔离、备注持久化；现有邮箱／备注／节点／套餐／组织搜索已实现，再按规模完善筛选、分页、保留策略、容量测试和运维备份。未在此轮实现账号池自动调度、自动换号、批量登录或对第三方额度的主动轮询。
6. 试点验收后再决定 stable 推广和把完整工作分支推到 GitHub；当前 bundle 是跨电脑继续开发的可用源码来源。

## 9. 可直接给下一台电脑 Codex 的提示词

> 请继续 CC Desk Tunnel 定制管理中心开发。先完整阅读根目录 DEVELOPMENT-HANDOFF.md，核对分支 codex/account-monitor-production、git status、最近提交以及 VPS 实际发布身份。当前源码通过交接 Git bundle 恢复，不要 reset 到较旧的 GitHub 分支。产品目标是独立页面的账号监控／客户端更新／审核，以及很多账号的清晰管理；只把 Ubuntu 正常使用中已得到的数据被动同步给 VPS，VPS 页面只读缓存。首台监控安装和服务端受管首次 bootstrap 均已在真实 Ubuntu 成功（Build 2／协议 20），用户确认最新客户端连接和会话正常；VPS 已收到1节点1账号自然上报，身份/邮箱/Claude Pro套餐、额度及usage有数据。主机重启、特殊状态、多账号及后续升级/回滚尚待实机验收，其余五台暂停。此前 CLI 单字节差异已恢复完整同版本官方文件，原因未知，不要重跑修复或首次接入。不要主动调用 Claude／额度／JEV，不启动真实原生终端，不升级 CLI／SDK，不重登／换出口。当前发布 Build 与哈希以本文档、签名索引和 CURRENT-RELEASE 为准，任何新包用新 Build。生产私钥／令牌仅在 VPS 使用，保留审核策略与数据，不执行旧宿主源码重建或历史 .local 激活脚本。请先说明你核对的状态和将处理的下一项，再在现有授权范围继续；无需再次询问已授权的实现方案。
