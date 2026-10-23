# CC 管理中心开发交接（2026-10-24，香港时间）

这是本项目当前工作状态与跨电脑续做的权威入口。旧文档中的 Build 2/3、未接入客户端、没有续期等陈述属于历史阶段；遇到冲突以本文件及 VPS 实际签名索引为准。生产状态是检查时的快照，后续 revision／有效期会自动续期。

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
| 签名下载 | pilot 客户端 Build 5、Linux 服务端 Build 2；版本 0.3.6，协议 20；stable 保持空通道 |
| 续期 | Windows 与 Linux 各有独立 systemd timer，登记精确源码／制品身份；不会自动推进 Build 或同步上游 |
| 被动监控代码 | schema 2、邮箱／备注、身份／额度时效、重试与缓存已实现 |
| 第一台监控接入 | 用户已在 Ubuntu 控制台安装成功；备份见下文。VPS 最近核对仍是 0 个账号、0 个已上报节点，不能声称已自然上报 |
| 第一台服务端受管升级接入 | 尚未在真实 Ubuntu 执行首次 bootstrap。离线测试和隔离镜像验证不等于实际节点已迁移 |
| 本机桌面安装 | 新包已提供；本轮未自动给用户电脑安装或升级 |
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

### 最终发布与验证快照

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
- 受管服务端 bootstrap 首次尚未执行。仅支持已审查的首台 profile；使用管理中心最新动态生成的命令，不复用聊天中的旧 hash／一次性代码。
- 已审查官方 CLI 原始 SHA256：`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`。原试点没有 CLI stamp，脚本按原始字节、root 所有权和权限验证，不执行 `claude --version`。

首次 bootstrap 会验证已有源码、运行环境和只读审核策略，隔离无网预检后保存冷备份，替换容器时保留配置／挂载／网络／数据。既有镜像可能派生于此前审核镜像，不得因为与老 base ID 不同就直接替换。依赖、持久化、审核 hook 或固定运行环境不兼容时明确要求人工镜像升级；程序更新不自动升级 CLI／SDK。监督程序属于不可变镜像，修它需要对应镜像／首次接入，不能把普通业务程序包视为自动更新了旧镜像监督器。

## 8. 接下来按什么顺序做

1. 在新电脑恢复交接 bundle，先看工作树和本文档，核对线上签名索引／CURRENT-RELEASE；不要重复历史发布。
2. 用户方便操作首台 Ubuntu 时，结束所有任务、关闭 CC，按管理中心“客户端更新 → 配套服务端 → 首次接入命令”执行一次最新 bootstrap。保留本机打印的私有备份路径；失败按实际日志诊断，不读／打印账号文件。
3. 用户选择安装最新完整桌面包。正常使用 CC，观察已有身份／额度事件是否被动上报；在 VPS 核对邮箱、节点、账号备注、身份／额度状态与时间，确认缓存滞后、退出、未知、错误等状态区分正确。没有自然数据就标为待验证，不为演示主动调用第三方接口。
4. 在首台完成真实安装、重启、正常使用及失败恢复演练后，再决定其他节点接入；每台先核实真实镜像／源码／版本，独立审核与上报身份，不共用秘密、不自动登录 Claude。
5. 多账号后续工作：在真实自然样本下核验同账号多节点归并、换号后归属、未知字段和额度缓存隔离、备注持久化；现有邮箱／备注／节点／套餐／组织搜索已实现，再按规模完善筛选、分页、保留策略、容量测试和运维备份。未在此轮实现账号池自动调度、自动换号、批量登录或对第三方额度的主动轮询。
6. 试点验收后再决定 stable 推广和把完整工作分支推到 GitHub；当前 bundle 是跨电脑继续开发的可用源码来源。

## 9. 可直接给下一台电脑 Codex 的提示词

> 请继续 CC Desk Tunnel 定制管理中心开发。先完整阅读根目录 DEVELOPMENT-HANDOFF.md，核对分支 codex/account-monitor-production、git status、最近提交以及 VPS 实际发布身份。当前源码通过交接 Git bundle 恢复，不要 reset 到较旧的 GitHub 分支。产品目标是独立页面的账号监控／客户端更新／审核，以及很多账号的清晰管理；只把 Ubuntu 正常使用中已得到的数据被动同步给 VPS，VPS 页面只读缓存。首台监控安装已成功但自然上报待验，服务端受管升级首次 bootstrap 尚未在真实 Ubuntu 执行，其余五台暂停。不要主动调用 Claude／额度／JEV，不启动真实原生终端，不升级 CLI／SDK，不重登／换出口。当前发布 Build 与哈希以本文档、签名索引和 CURRENT-RELEASE 为准，任何新包用新 Build。生产私钥／令牌仅在 VPS 使用，保留审核策略与数据，不执行旧宿主源码重建或历史 .local 激活脚本。请先说明你核对的状态和将处理的下一项，再在现有授权范围继续；无需再次询问已授权的实现方案。
