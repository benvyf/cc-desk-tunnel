# 账号监控生产部署记录

2026-10-23（Asia/Hong_Kong）。VPS 已部署并完成正式 HTTPS 验收，导航版本为下文记录的 `f610908`；最新接入入口见文末；六台 Ubuntu 尚未接入，不是账号采集全链路上线。

线上原运行归档来源为 `2638731374c87e767eca6ff1ec37b6a7352ab4d1`，包含审核、节点审核接口和密码登录。已逐文件校验其 BUILD-INFO SHA256 并取回无配置运行源码，与账号监控 `e99d10b` 合并；审核和密码模块按原字节保留，HTTP 和页面作兼容合并。

上线仅重启独立的 `cc-update-service`，保留整份生产配置及数据。先停止服务并备份完整数据目录，再部署；不回滚到历史空通道数据、不覆盖现有审核阈值/API 密钥/管理员密码、不调用 Claude 或 JEV 验收。

六台 Ubuntu 尚未接入监控。用户确认现有操作路径为 UU 远程 Windows → 虚拟机控制台，当前工具无法操作该桌面；不可把 VPS 管理页就绪等同于节点已经上报。当前节点源码和协议/配套客户端应在控制台核实后试点，不能直接用旧归档覆盖已上线的审核门禁。

## 监控首次上线版本和备份

- 分支：`codex/account-monitor-production`，运行来源提交 `129f0fc55264b3195bd164014d052cad93f41497`。
- 归档：`artifacts/cc-update-service-monitor-129f0fc.tar.gz`，SHA256 `5fc5d30cd1c259667099f27788cfeaaecc8012484f8fe6c7d51a6ec6a2a03fae`。
- 一致备份：`/var/backups/cc-update-service/monitor-20261023T145656Z`，包括停止服务后复制的整份 `/srv/cc-update-service`、原运行目录、配置、unit 和 Nginx 配置。
- 原运行目录另保留为 `/opt/cc-update-service.previous-monitor-20261023T145656Z`。回滚先停止服务并恢复此目录与备份的 `config.json`；不要用历史空通道备份覆盖当前发布数据。监控库可保留，旧版本不会读取。
- 六个独立节点已登记：`ubuntu-cc`、`ubuntu-cc-02` 至 `ubuntu-cc-06`。各自 `.env` 保存在 VPS root-only `/root/.cc-account-monitor/`；不能把其中一份复制到多台。令牌不在源码、归档或本文中。

## 监控首次上线验收证据

本地全量回归 374 项，343 通过、31 跳过、0 失败。真实浏览器测试另外通过密码设置/登录、令牌兼容登录、备注保存与重登、搜索/历史绑定/移动布局及审核分区。合并接口测试验证密码会话能管理监控，节点凭据不能读取账号、修改审核或访问更新管理。独立复核没有阻塞问题。解包后的 28 个运行文件 hash 和本地合成上报/读取/备注 smoke 通过。

VPS 正式域名页面和四个 JS/CSS 资源返回 200，未授权监控读取返回 401，管理员读取返回 200；六个配置节点、零已上报节点、零账号。审核配置/用量和更新状态接口均为 200，节点审核接口无凭据为 401，private URL 为 404。当前 Windows 电脑也经正常证书校验访问正式 HTTPS 页面成功。未用真实账号或 JEV 发验收请求。

上线前后 `state.sqlite`、`moderation.sqlite` 的逻辑内容逐字比较一致，管理员密码文件和审核节点注册表字节一致；完整原配置仅增加 `monitorNodes`。28 文件 manifest 再次校验通过，service active/enabled，Nginx 和 systemd unit 字节未变，七个原容器 ID 未变且保持健康。服务日志未发现启动错误或新增节点令牌。

脱敏生产结果位于该备份目录的 `result.json` 和 `https-verification.json`。本次没有增加 Claude/JEV 请求，没有重启或更改 Ubuntu、Docker 容器、Nginx 或中转隧道。

## Ubuntu 接入仍需完成

当前可用入口是 UU 远端桌面 → Windows → Ubuntu 虚拟机控制台，当前执行工具无法操作该桌面，没有可用的 Ubuntu SSH 管理路由。VPS 上的 28787–28792 是转发到 CC 8787 的业务连接，不能当作 SSH 端口。

第一台已经按下文完成基线和运行源码回传；现改为账号页生成一次性命令接入，已取消 SSH 公钥交付，不应运行旧准备脚本。其余五台暂不接入，不需要登录账号。后续按实际运行配方准备部署、备份并检查无活跃任务，不能直接安装旧 `e99d10b` 服务端包或拿宿主旧源码覆盖生产审核实现。

日后正常使用自然产生的身份/额度事件才会上报；不要为了让监控立刻有数据触发 Claude 查询或测试消息。

## 顶部导航与独立功能页（历史导航上线记录）

2026-10-23 23:10 HKT 部署运行提交 `f610908aac9597e34161867a328c91a2a3bc63d3`。归档 `artifacts/cc-update-service-monitor-f610908.tar.gz`，SHA256 `85c7de16c08c1e6a701b895063c39944a2f6c1ec2c0507f3e4d648905a410ca9`。

统一顶栏包含三个独立页面：

- 账号监控：`https://api.ghostapi.org/cc-updates/admin/accounts`
- 客户端更新：`https://api.ghostapi.org/cc-updates/admin/updates`
- 内容审核：`https://api.ghostapi.org/cc-updates/admin/moderation`

根入口默认账号监控。导航支持直接链接、刷新和浏览器前进/后退；整页刷新因凭据只保存在内存中需重新登录，登录后回到该地址对应功能。一次只展示一个功能，当前页单独读取 VPS API；只有账号页处于可见状态且无草稿/编辑时才每30秒刷新其缓存。切页保留备注草稿，操作中的历史导航完成后补载最新目标页。

本轮管理服务27项测试全部通过，含真实浏览器的独立路由、按页读取、延迟请求期间后退、备注保留、轮询启停、刷新重登、密码设置及移动端布局；类型/格式/索引/差异检查通过。独立复核无阻塞问题。解包后29个运行文件hash和接口smoke通过。

一致备份：`/var/backups/cc-update-service/admin-pages-20261023T151030Z`，原运行目录：`/opt/cc-update-service.previous-admin-pages-20261023T151030Z`。完整配置字节未变，三个数据库逻辑内容与密码/审核节点身份文件逐一比较一致，Nginx和unit未变。回滚时先停止服务并恢复此原运行目录；当前配置无需修改，不用旧数据覆盖新收到的上报。

正式HTTPS三个页面GET/HEAD均200，新增navigation.js为200，未知功能404，未授权监控API为401；29文件manifest再验通过，服务active/enabled。当前Windows以正常证书校验进行了真实线上浏览器验收：三页切换/隔离、按页请求、历史后退、手机无溢出、退出清数据和零脚本错误均通过。仍为六个配置节点、零已上报节点、零账号，没有Claude或JEV测试请求。

远端备份中的 `result.json`、`https-verification.json` 以及本地忽略目录 `.local/admin-pages-production-evidence/` 保存脱敏结果和浏览器截图。本机最初的旧管理令牌已不匹配生产，未用于继续验收；后续浏览器验收经已有SSH权限在进程内读取当前生产身份，无凭据落盘或输出。

## 第一台接入准备（2026-10-24，尚未启用）

用户确认只有第一台有Claude账号，本阶段只接入 `ubuntu-cc`。用户回传基线和源码差异后已完整还原37个运行源码文件并逐文件SHA256校验。宿主 `/opt/cc-desk-tunnel` 是0.3.5／协议19；实际容器 `/app` 是0.3.6／协议20，镜像 `sha256:75e9c5895bfa232d78905bf1dbf127af173d9f5de88086dc93af80833c8a3b8f`，容器名 `cc-desk-tunnel-ba938975-proxy-1`。上游最新正式版核对为v0.3.6。

已在当前开发分支将实际审核逻辑与监控三方合并，`moderation.ts`、`native-moderation-hook.ts`、`native-terminal-policy.ts` 与回传生产源字节一致。只需补丁6个源码文件，不升级CLI/SDK、不替换入口、Web UI或现有依赖。服务器/协议215项通过；包内监控、native-controls及兼容集成测试29项通过，类型/格式检查及独立审查通过。全部离线合成数据，无Claude/JEV请求。

源码包 `artifacts/cc-ubuntu-monitor-source-pilot.tar.gz` 为47523字节，SHA256 `4e3e27fdf11016a69fc3fb3ca3b0e7d83481b2d6eb31a45a8dc8fe3a98b5ec8d`。包含运行基线manifest、6文件补丁、离线测试、FROM当前镜像的Dockerfile；**不包含正式启用脚本**。VPS root-only `/root/.cc-account-monitor/ubuntu-cc-pilot/delivery.tar.gz` 已暂存该源码包与第一台独立监控env，令牌哈希已与现有节点注册比对。尚未添加任何SSH授权，没有修改运行中的VPS配置或Ubuntu。

旧 `scripts/prepare-ubuntu-monitor-pilot.sh` 的 SSH 公钥方案已取消，不要运行；下方的一条命令接入替代它。不能把源码准备完成视为节点已接通。


## 一条命令接入（2026-10-24）

账号监控页提供“一键接入” → 选择 `ubuntu-cc` → “生成接入命令” → 复制，在第一台 Ubuntu 控制台粘贴执行。其他五台没有经过核验的运行包，暂时禁用。入口上线不代表 Ubuntu 已执行；节点仍需用户通过 UU → Windows → Ubuntu 控制台运行命令。

管理员凭据只用于生成十分钟、单次、节点及包摘要绑定的安装码。安装码仅存 SHA256，重新生成会撤销本节点旧码；永久节点令牌不返回网页、不进入 URL 或源码。节点通过无浏览器 Origin 的 HTTPS POST 领取 root 准备的私有包。匿名错误尝试不会阻断合法码。页面退出和过期会清除显示命令；不写浏览器持久存储。包位于 `/srv/cc-update-service/private/enrollment`，不是静态下载路径。

安装器只支持已核验的 v0.3.6 镜像和37个运行文件。保留容器 Entrypoint、Cmd、Env、挂载、静态端口、网络别名、健康检查及安全设置，只增加三个监控环境变量；禁止使用旧宿主源码或 Compose。先以本地镜像标签离线构建及运行29项模拟测试（无网络、无账号/数据挂载）。拒绝动态端口、额外可写挂载及不支持的配置。

切换前冻结进程，并检查 Claude/SDK 子进程、会话 activeRun、仍连接的 CC 客户端或外部审核 TCP 连接；有任务或连接就恢复运行并退出。确认空闲后保持冻结停止旧容器，冷备份完整数据（含 SQLite WAL）及配置，commit 保留本地可写容器层，再从快照派生补丁镜像并重建。源文件归 root、0644，防止 Windows 归档模式造成可写运行源码。所有备份/快照留在 Ubuntu 本地，不上传账号数据。新容器只执行原本的本地健康检查，不作 Claude/JEV 探测。

失败自动尝试恢复旧容器及网络；保留 `/var/lib/cc-monitor-install/backup-*` 内完整原配置、数据、回滚脚本及快照 ID。回滚不以旧备份覆盖当前业务数据；人工回滚支持已停止的新容器，运行中则先冻结并检查空闲。断电或外部强制终止安装器不保证自动回滚，须保留控制台输出的本地备份。以后若重建/升级容器，需保留新的补丁镜像和三个监控环境变量；旧 Compose 不应覆盖当前运行配置。

安装成功后等待正常 CC 使用产生的账号/额度事件自然上报；不主动刷新 Claude、不新增采集定时器。管理页刷新只读 VPS 缓存。VPS 上线前后须校验现有数据库、密码、审核身份及配置保持一致。


### 接入入口正式上线验收

VPS 已部署运行提交 `1bf5b4ba65e292c413c5ac5aedb61fc7a734802d`，归档 `artifacts/cc-update-service-monitor-1bf5b4b.tar.gz`，SHA256 `5254202ce07ae5819bd0f2c4be7e3e8979f91b79d7097928ec15334940959188`。32个运行文件逐一校验通过，systemd active/enabled。

一致备份：`/var/backups/cc-update-service/enrollment-20261023T163520Z`；原运行目录 `/opt/cc-update-service.previous-enrollment-20261023T163520Z`。整份配置、密码/审核身份字节以及 state/moderation/monitor 三个数据库逻辑内容保持一致。回滚仅切回旧运行目录，保留当前数据及配置，不恢复旧数据库。

第一台私有包46668字节，SHA256 `b0b434fed89490eb5a5756c722c24753260cbedf0cab3e3a8140c0ba26dc18de`，仅位于服务私有目录，公开路径404。内含经过核验的6文件补丁、37文件manifest、29项模拟测试及第一台现有独立同步env，永久令牌不在运行归档或文档中。

上线前回归 Node 243/243、Python 5项（含安装成功及4种失败子场景）、类型/格式/索引及归档解包smoke均通过；独立复查无P1/P2阻塞。VPS隔离Docker fixture用本地Ubuntu镜像、无外网内部网络验证保持冻结停止、可写层快照、配置/挂载重建、本地健康以及停止容器回滚和网络别名恢复。实际第一台镜像的29项离线模拟测试会在用户执行命令时先跑，未通过则不切换。

正式域名经正常证书校验的真实浏览器验收通过：登录、首台可选/其余五台禁用、生成和复制命令、私有包单次领取及SHA256、重复领取401、浏览器领取403、公开包404、独立路由/手机无溢出/零脚本错误。测试领取仅在验收进程内校验摘要，未安装到节点，也未发送合成账号报告。脱敏证据保存在 `.local/enrollment-production-evidence/` 及上述备份目录。

验收时仍为6个配置节点、0个上报节点、0个账号。**Ubuntu还没有执行安装，不能宣称已接通。** 下一步由用户在账号页生成新命令，通过UU远端电脑进入第一台Ubuntu控制台执行；本次没有新增Claude/JEV请求。


### Docker 29.9 进程列表兼容修复（2026-10-24）

用户第一台 Ubuntu 实测 Docker29.9.1 / API1.56，旧安装器在下载前报 HTTP500；只读诊断确认容器 running/paused=false，`docker top ... -eo comm` 返回 `Couldn't find PID field in ps output`。旧安装器的 `-eo args` 同样漏掉 Docker 所需的 PID 列。

修正安装前、冻结后及人工回滚三处查询为 `-eo pid,args`。模拟该守护进程约束后旧实现失败，新实现通过 Python5项（含成功/失败子场景）；PID列不影响 Claude/SDK 忙碌检测。管理服务28项（含真实浏览器）通过；隔离 Docker 环境的运行中及暂停后 PID+args 查询通过，独立复查无阻塞。没有升级 Docker、改动业务容器或新增 Claude/JEV 请求。正式 Ubuntu 需使用更新后页面重新生成的命令重试；旧命令绑定旧安装器摘要，不能继续使用。
