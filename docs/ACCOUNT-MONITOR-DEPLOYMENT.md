# 账号监控生产部署记录

2026-10-23（Asia/Hong_Kong）。VPS 已部署并完成正式 HTTPS 验收，当前运行版本为下文功能页更新的 `f610908`；六台 Ubuntu 尚未接入，不是账号采集全链路上线。

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

第一台已经按下文完成基线和运行源码回传；下一步由控制台运行 `scripts/prepare-ubuntu-monitor-pilot.sh` 准备受限领取公钥及部署摘要。其余五台暂不接入，不需要登录账号。后续按实际运行配方准备部署、备份并检查无活跃任务，不能直接安装旧 `e99d10b` 服务端包或拿宿主旧源码覆盖生产审核实现。

日后正常使用自然产生的身份/额度事件才会上报；不要为了让监控立刻有数据触发 Claude 查询或测试消息。

## 顶部导航与独立功能页（当前版本）

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

`scripts/prepare-ubuntu-monitor-pilot.sh` 供用户控制台执行，只核对原镜像、在 `/var/lib/cc-monitor-pilot` 创建root0700目录、保存原容器完整inspect（0600，仅本机）、生成临时传输私钥（0600）并输出**公钥**及白名单部署摘要。不读取/输出账号或服务凭据，不联网、不调用CLI、不重启。当前等待此准备结果，以核实Compose/网络/挂载配方，再提供受限只读领取、离线构建验证、备份/启用和回退命令。不能把源码准备完成视为节点已接通。
