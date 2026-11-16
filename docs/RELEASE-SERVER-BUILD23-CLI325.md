# Linux Build 23：Claude CLI 2.1.325 / Fable 5.2

2026-11-16（香港时间）。Linux pilot 已发布 **Build 23 / 0.3.10 / 协议 24**，发行源码 `a7ffa819a7f030b9435dc093cd91a3376375651f`。Claude CLI 从 2.1.295 更新为 2.1.325，SDK 保持 0.3.286；Windows pilot 保持 Build 35。没有给 Ubuntu 创建或执行安装任务。

## 原因与变更

模型刷新读取 Ubuntu CLI 的初始化目录，不安装新版 CLI。官方 2.1.321 才加入 `claude-fable-5-2`；实机 2.1.295 返回旧目录。隔离环境已用真实 2.1.325 和现有 SDK 读取到 `fable → claude-fable-5-2`，包含模型说明和 low/medium/high/xhigh/max。

本地交接停在 Build 20，线上实际已是 Build 22、三台 Ubuntu 上报 Build 21。此次通过公开签名索引及归档逐文件恢复 Build 22 的发行基线；原源码提交 `cf00d93018eb373f3fee5fac44bb817ff7ef9786` 的 Git 对象未能从现有源码库取回，恢复基线提交为 `204c1419`，没有把它冒称为原提交。所有 138 个 Build 22 Web 资源按原字节保留，打包器新增经过归档摘要、清单和协议验证的 Web 复用入口。

新运行身份为 `node24-cli2.1.325-v4`。迁移入口分别验证原 CLI 和目标 CLI，加入 Build 22 的精确描述符准入；只在候选镜像内替换 CLI，继承原 Node 和基础镜像层。CLI 官方归档 SHA512、归档 SHA256、完整二进制 SHA256 均固定校验。新版二进制 365,842,960 字节，安装器读取上限从 300 MiB 调整为 512 MiB，摘要校验保留。

默认引用保护清理、空间预算、任务与终端空闲校验、受控断开、冷备份、健康检查、失败恢复和必要回退轮转沿用线上基线。账号、持久目录、协议、SDK、模型出口和现行审核范围不变。

首次安装使用新公开路径 `fresh-install-v5.py`。管理中心仅修改 `http.ts`、`fresh-nodes.ts` 并新增该脚本，保留原中心独立功能；旧 `fresh-install.py`、v3 和 v4 返回原字节。中心源码主体仍记为原 `cf00d930...`，新增 overlay 记录实际发行源码及三个变更文件，没有把整个中心冒称为此次分支源码。

## 验证及边界

- 隔离 Linux：迁移、CLI 固定摘要、清理与备份引用保护合计 33 项；首次安装 7 项；冷备份及失败恢复 16 项通过。节点和 Docker 调用在这些单元测试中使用替身；另执行真实 Docker 迁移配方构建、实际 PTY 依赖记录与探测、最终归档对应镜像的全部清单校验。最终安装器读取上限修订后，真实执行官方 HTTP 下载和完整二进制校验，未执行 CLI 登录。
- 本机关键账号、终端、模型映射和审核回归 37 项、实际打包回归 1 项及类型检查通过。打包回归覆盖缺失迁移依赖、保留 Web、拒绝错误摘要以及构建中源码变化。
- 断网容器中的真实 CLI：8 条审核故障/正常路径与 `--bare`、`--safe-mode` 两条路径通过；审核失败未触达回环模型替身。真实 PTY 与 SDK 验证新消息审核、问答回复维持现行范围、SDK 不重复审核以及正常控制回调。使用回环模型和审核替身，没有真实模型、JEV 或生产账号请求。
- 旧 PTY 脚本仍要求已经退役的 PostToolBatch/问答回复审核，因此第一次运行失败。确认 Build 21/22 的现行代码已明确只审核新提交消息后，按该基线调整隔离验证脚本；没有恢复退役钩子或改变线上策略，不能把该旧测试失败描述为新版 CLI 的已证实回归。
- 最终 245 个发行文件验证通过，138 个 Web 资源与 Build 22 一致。VPS 与开发电脑独立核验公开签名和完整下载摘要。
- 实际执行公开签名迁移入口自己的 HTTP 索引下载、验签、第二次归档下载和严格解包，确认下载的是 Build 23。在原生 CLI 下载、Docker 构建及停机前主动停止；节点、活动和空间状态使用替身，不冒称真实 Ubuntu 已安装。
- 线上实际 agent 在模拟 Build 16/18/20/21/22 的状态下均选择新签名归档中的 `apply.py`。真实 systemd 续期成功，Linux revision 40，两个续期 timer 和管理中心 active；Windows pilot/stable 索引和六台节点记录/既有任务保持。
- 隔离测试镜像、27 个本次无标签中间镜像和临时上下文均已按明确归属清理；原 7 个运行容器和 5 个镜像保持，VPS 可用空间恢复至 5,812,932,608 字节。运行引用的源码、发行包、日志和必要备份保留。

## 发行与恢复记录

- [Build 23 归档](https://api.ghostapi.org/cc-updates/server/v1/artifacts/23/linux-x64/cc-desk-tunnel-server-0.3.10-build23.tar.gz)：8,178,471 字节。
- SHA256：`823dd1c642ceced1f3f8be5df226312ae046843a71a4a5d965238dc79b84c37e`。
- 新 CLI 二进制 SHA256：`0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf`。
- 中心冷备份：`/var/backups/cc-update-service/cli325-installer-20261116T032605Z`，包含私有状态冷备份和配置；切换及校验约 2.317 秒。
- Linux 发布备份：`/var/backups/cc-update-service/server23-publication-20261116T032609Z`。
- 精确续期登记指向新 release；`zz-runtime23.conf` 使用 `/root/.cc-update-admin/linux-build23-preparation/source`，该干净源码及引用制品不得清理。
- [结构化证据](evidence/linux-build23-cli325-2026-11-16.json)。旧制品未原位覆盖。

## 用户安装

刷新[管理中心](https://api.ghostapi.org/cc-updates/admin/updates)，为目标 Ubuntu 生成 **Build 23** 的新升级任务/指令，按中心当前入口执行；不要重试之前复制的 Build 20/21/22 指令。不需要重新接入或在宿主机执行 `claude update`。

升级成功后核对容器内 CLI 为 `2.1.325`，重新连接客户端并刷新模型列表，验收 `claude-fable-5-2`。发行并不代表用户节点已经安装。若现有回退归档摘要异常或空间不足，仍由升级流程保留现场并安全停止，不删除备份或改写摘要。
