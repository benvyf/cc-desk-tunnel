# Linux 服务端 Build 31 发布记录（协议 25）

2026-11-19（UTC 02:03）发布到服务端 pilot 通道。只发布软件包与升级指令；节点由用户在管理中心发起。

| 项目 | 值 |
| --- | --- |
| Build / 协议 / appVersion | 31 / 25 / 0.3.10 |
| 运行时级别 / 依赖锁 | `node24-cli2.1.325-v5` / `a884b488…`（与 Build 30 相同） |
| 源码提交 | `a8c1ea9dec804b1cda3e7b913bb8e414c56aa48a`（分支 `release/server-build31`） |
| 归档 | `cc-desk-tunnel-server-0.3.10-build31.tar.gz`，8590254 字节，sha256 `3311119e961cd1f169a85120a28f6fb5e3646ebd19312c57baedde6dadcb7908` |
| 描述文件 | `f199a1e7858faa52ee8e965c084dd37454e6eb7c407badfad6632680f1815f68` |
| 公开索引 | pilot revision 54（发布 53 + 强制续期 54） |

## 为什么需要 Build 31

ubuntu-cc 升级 Build 30 时：一是 11-16 失败的 Build 27 接管留下了维护标记（经用户同意人工解除，见 `/root/.cc-update-admin/ubuntu-cc-maintenance-clearance/`，数据库备份在 `/var/backups/cc-update-service/`）；二是第一次重试因本对话运行在 ubuntu-cc 上、任务未空闲而等待超时；三是第二次重试在接管准备阶段因暂存的 Build 27 `host-operations.py`（`95cbe6d3…`）不在可修复列表而停止。三次均在切换前停止，服务未改动。

## 内容（只改 `deploy/host-update/apply.py`）

- `repair_process_reader` 可修复签名 Build 27 的 `host-operations.py`；其余四个稳定源与 Build 30/31 相同。
- `/data/managed-server/journal.json` 缺失且容器内未安装任何版本时，视为监督程序自身的默认日志；确认后立即以“临时文件 + fsync + link，不覆盖”写入运行中的原容器，使冻结源码校验、冷备份和回滚后的宿主自检都能读到；切换后再确保新容器有该文件。已有文件不写；写入失败以明确原因在任何改动前停止。
- Build 30（`fa5779e2…`，协议 25）列为基线。

## 验证

- Fable 5.2 复核三轮：首轮发现冻结源码校验也读 journal（阻塞），已修复；复核确认无遗留阻塞。
- VPS（Linux，root）：host-update 全部 Python 套件通过（含 `main()` 流程 22 项、真实脚本写入/不覆盖测试），bootstrap 16 项。
- 隔离实验构建：镜像 644,472,166 字节，基础层、全部文件、真实 PTY、目标容器就绪、切换前 CLI 准入通过；未切换服务，模型请求 0。
- 发布：签名、公网索引与完整下载、续期登记与强制续期、Windows 索引未变、未创建节点作业。管理中心 `desktop-access` 两个现场修改文件按用户确认的哈希放行。
- 备份：`/var/backups/cc-update-service/server31-publication-20261119T020325Z`。

## ubuntu-cc 结果（2026-11-19）

- 管理中心流程第三次重试（`0a580ca1…`）在 ubuntu-cc 上构建出的候选镜像未通过 `candidate_check`：镜像内 Claude CLI 大小正确（365,842,960 字节）但 sha256 为 `f51d1888…`，与官方 `0dc4f4a9…` 仅相差 1 个字节（偏移 333,636,241）。原服务未切换。
- 诊断：同一文件在 ubuntu-cc 磁盘上写入 5 次、清缓存后读回，3 次哈希错误且各不相同；在 `/dev/shm` 内存盘中 6 次全部正确。结论为磁盘或存储链路静默数据损坏（内核无报错），与 2026-11-16 Build 27 在该节点的镜像层 crc32 错误一致。ubuntu-cc-03 在同一流程下镜像检查通过。
- 用户在管理中心流程之外手动完成升级：Claude CLI 与 Node 放在只读、禁用交换的 tmpfs（`/run/cc-first-build31-runtime`），以只读方式绑定挂载到容器的 `/opt/runtime/cli/bin/claude` 与 `/opt/runtime/node/bin/node`。核验：Build 31 / 协议 25，描述文件 `f199a1e7…`，257 个程序文件全部一致，CLI `0dc4f4a9…`，Node 二进制 `904a6d34…` 与官方 24.22.2 一致，SDK 0.3.325，默认 journal 存在。
- 遗留：
  1. `/run` 在重启后清空，需在 Docker 启动前重建只读 tmpfs 并按哈希装入 CLI 与 Node，否则容器无法启动。
  2. 镜像内 npm 依赖与系统软件包仍在损坏磁盘写出的层中，未逐字节核对。
  3. 管理中心中该节点仍为 legacy、带维护标记，容器多出两个非标准挂载，后续受管升级会因配置不同被拒绝，在磁盘修复前需手动处理。
  4. 用户数据仍在该磁盘上，需异地备份并由云服务商修复或迁移。
