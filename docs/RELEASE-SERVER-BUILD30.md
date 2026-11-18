# Linux 服务端 Build 30 发布记录（协议 25）

2026-11-18（UTC 11:38）发布到服务端 pilot 通道。只发布软件包与升级指令；未升级任何节点（用户选择稍后升级 ubuntu-cc）。

| 项目 | 值 |
| --- | --- |
| Build / 协议 / appVersion | 30 / 25 / 0.3.10 |
| 运行时级别 | `node24-cli2.1.325-v5`（与 Build 29 相同） |
| 源码提交 | `4d4a89d72b6313611930369f52e556c45ac49789`（分支 `release/server-build30`） |
| 归档 | `cc-desk-tunnel-server-0.3.10-build30.tar.gz`，8588826 字节，sha256 `e6bda32c843a9c852c93da6f815ce15daba3a842ce17a2735414614ca25ae60b` |
| 描述文件 | `fa5779e29341d16cf71da34ef68810cf7436c94135e856f13b78a522863e1a47` |
| 依赖锁 | `a884b488…`（与 Build 29 相同，Agent SDK 0.3.325） |
| 公开索引 | pilot revision 52（发布 51 + 强制续期 52），有效期至 2026-12-02 |
| 配套客户端 | Windows Build 39（协议 25，stable）；Build 38 在服务端要求协议 25 时可应用内一键更新 |

## 内容

- main 上的协议 25：子代理步骤、会话分支来源、回复模型、会话归档、`version_mismatch` 携带 `requiredProtocol`。
- `apply.py`：本路径第一次跨协议镜像升级（24 → 25）。目标协议 25，基线协议保留在 BASELINES；准入 Build 29（`7480a9d3…`，使用 LOCK）；`live_probe` 以运行中服务端自己的协议询问。Build 28/29 的容器内监督程序会拒绝本版本（依赖锁与兼容性摘要不同），节点经 apply.py 镜像路径升级。
- Web 客户端重新构建（此前 Build 23–29 沿用旧 Web，协议 24 不能复用）。归档在 Windows 上打包：Git Bash 的 `tar.exe` 指向 GNU tar，会把 `C:\` 当作远程主机，须在 PowerShell 中运行以使用系统 tar。

## 验证

- Fable 5.2 设计与代码复核：无阻塞问题。
- Linux（VPS，root）：host-update 全部 Python 套件通过，含 Windows 上跳过的 10 项 `main()` 流程（22/22）；bootstrap 16 项通过；`fresh-installer` 1 项失败，在已发布 Build 29 源码上同样失败，与本次改动无关。Windows：Node 协议/服务端/更新服务 94 项通过。
- VPS 隔离实验构建（`linux-build30-preparation/build-lab.py`）：镜像 644,459,223 字节（上限 3 GiB），基础层、全部文件哈希、真实 PTY、目标容器就绪、切换前 CLI 准入通过；未切换服务，模型请求 0；实验镜像已清理，生产镜像不变。构建期间根分区可用空间一度降到约 1.7G，结束后恢复 5.5G。
- 发布（`prepare.py`/`publish.mjs`，沿用 Build 29，改身份、协议 25 与基线 28/29）：签名、公网索引与完整下载、续期登记与强制续期、Windows pilot/stable 未变、未创建节点作业。续期服务单元指向 `linux-build30-preparation/source`。
- 管理中心运行文件 `desktop-access.ts`/`desktop-access.js` 于 2026-11-18 02:11 UTC 被直接修改（中转主机地址、未配置连接的工作空间不可授权），不在 BUILD-INFO 与任何 Git 提交中；经用户确认为有意改动，`prepare.py` 只对这两个文件的当前确切哈希放行，其余文件照常严格校验。**该改动需补入源码，否则下次部署管理中心会丢失。**
- 备份：`/var/backups/cc-update-service/server30-publication-20261118T113827Z`。

## 节点（发布时）

ubuntu-cc、ubuntu-cc-02、ubuntu-cc-03 均为 Build 28 / 协议 24、空闲。升级后协议 24 客户端（Windows Build ≤ 38、旧 Web 缓存）收到 `requiredProtocol: 25`；回退会恢复升级前冷备份，升级后新产生的数据保存在 `data.after-*`，不回到业务目录。
