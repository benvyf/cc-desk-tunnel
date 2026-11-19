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
