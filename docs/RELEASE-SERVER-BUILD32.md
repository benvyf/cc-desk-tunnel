# Linux 服务端 Build 32 发布记录（协议 25）

2026-11-20（UTC 11:58）发布到服务端 pilot 通道。本次只发布了软件包和升级指令，没有创建任何节点升级作业。

| 项目 | 值 |
| --- | --- |
| Build / 协议 / appVersion | 32 / 25 / 0.3.10（原因见下文“依赖锁”一节） |
| 运行时级别 / 依赖锁 | `node24-cli2.1.325-v5` / `a884b488…`，与 Build 30、31 相同 |
| 源码提交 | `c205d9794d6a28eb4f53f77ec78cb074cf57570d`（分支 `release/server-build32`，未合入 main） |
| 归档 | `cc-desk-tunnel-server-0.3.10-build32.tar.gz`，8618882 字节，sha256 `9eb2ea77917500462df167655832edbcbafe0e6c12620ee2297f01f629087386` |
| 公开索引 | pilot revision 56（发布为 55，强制续期后为 56），有效期至 2026-12-04 |
| 发布主机 | VMISS `189.105.70.247`（管理中心已于当日迁到这台） |

## 内容

服务端相对 Build 31 的变化，均来自 main：

- **用量长期保存**：每次调用另按“UTC 小时 × 模型”累加到 `usage_hours`，永久保留。单次明细仍只保留 35 天。升级后，现有明细会按水位补算进去，汇总概要里带 `keepsHistory`。
- **桌面授权按节点批量续期**：通过 `/cc-access/v1/renew` 续期，租期 5 分钟，偶尔失败不会断开连接。管理中心较旧时，退回逐张向 `/validate` 续期（100 秒）。
- **服务端更新的忙闲规则**：空闲的终端、只在等后台任务的会话，不再阻止更新。更新只在最后一步结束仍在进行的会话，并写明原因。
- **两个权限设置**：`denyInsteadOfPrompting`、`blockWritesOutsideWorkingDirectories`。
- **用户消息按 ID 查找**：改走部分索引。
- **升级起点**：`deploy/host-update/apply.py` 把 Build 31（描述文件 `f199a1e7…`，协议 25，`LOCK`）列为升级起点。

因为 `store.ts`、`usage.ts` 和协议文件在兼容性清单里，Build 32 只能走镜像升级，不能在容器内只更新程序。

## 依赖锁（重要，后续发布务必注意）

主机升级要求候选版本的 `package-lock.json` 指纹等于运行时固定的 `LOCK`（`a884b488…`）。这个文件里记着桌面客户端的版本号，所以客户端 0.3.11、0.3.12 发布后指纹变了，尽管依赖本身没有任何变化。

第一次打包的 Build 32 因此被主机升级测试拒绝，报错为 “Candidate runtime/dependencies differ”。

处理方式和 Build 31 一样：服务端发布分支把 `apps/desktop/package.json` 和锁文件里的版本号保留为 0.3.10，锁文件因此与 Build 31 逐字节相同。所以这个分支**不能原样合入 main**。

main 上只合入以下三项，客户端版本号保持 0.3.12：
- 服务端 Build 号 32；
- Build 31 升级起点；
- 版本历史里的“0.3.12 / 服务端 32”。

以后从 main 打服务端包，仍要做同样的处理。根治办法是让这项检查忽略工作区自身的版本号，属于待办。

**更新（同日）：已根治。** 现在由打包脚本 `scripts/package-server.mjs` 自动处理：

- 打包时把锁文件里桌面工作区的版本号固定为 `SERVER_APP_VERSION`（0.3.10），只改这一处。改完后核对其余内容是否完全相同，不同就拒绝打包。
- 发布信息里的 appVersion 也取这个值。
- 已部署的检查代码一处都没有改动。

测试会检查：用树中的锁文件打包后，指纹必须等于 `apply.py` 的 `LOCK`。依赖真的变化时，这项测试会失败，这时要把 `LOCK`、运行时级别和 `SERVER_APP_VERSION` 一起更新。

以后从 main 直接打服务端包即可，**不再需要临时改版本号的发布分支**。

## 验证

- **Windows 本机**：服务端、协议、管理中心的 Node 测试共 482 项。有 2 项在 Git Bash 下失败，原因是 GNU tar 把 `C:` 当成远程主机名；在 PowerShell 下这 2 项也通过。
- **Linux（发布主机）**：
  - `test_host_image_retention`、`test_host_update_build11`（22 项）、`test_host_update_cleanup` 全部通过。
  - `fresh-installer` 和 `server-bootstrap` 两套测试，在 Build 31 源码上也同样失败，属于主机环境基线，与本次改动无关。
- **准备检查**：
  - 管理中心运行文件与 `BUILD-INFO` 一致（含 11-18 确认过的热修复）。
  - 归档中 257 个文件逐一核对。
  - 正式签名预演通过 `apply.verify_release`。
  - Build 28、29、30、31 均被接受为升级起点。
  - 发布时没有进行中的节点作业。
- **发布**：签名、公网索引和完整下载核对通过；续期登记改为 Build 32（`zz-runtime32.conf`），强制续期通过；Windows 两个通道（stable Build 41 rev 11、pilot Build 38 rev 68）不变；管理中心运行文件未改动；未创建 Ubuntu 安装作业。
- **备份**：`/var/backups/cc-update-service/server32-publication-20261120T115813Z`。这台机器原本没有 `/var/backups/cc-update-service`，是首次发布时建的。

## 管理中心迁移

2026-11-20 10:03–10:10 UTC，管理中心从 `212.50.248.138` 迁到 VMISS（`189.105.70.247`）：
- 旧机器上的 `cc-update-service` 和三个续期 timer 已停止并禁用。
- 新机器的 `/root/.cc-update-admin` 布局保持不变，四个续期 timer 均为 active。
- `api.ghostapi.org` 的请求现在由 VMISS 处理。

**后续发布都在 VMISS 上进行。**

## 节点状态（发布后）

- `ubuntu-cc`：用户当日在管理中心作业之外完成了升级，管理中心显示为 Build 32。该节点磁盘曾有静默数据损坏，Build 31 时采用了 tmpfs 只读挂载 CLI 和 Node，相关遗留见 [Build 31 记录](RELEASE-SERVER-BUILD31.md)。
- `ubuntu-cc-03`、`04`：Build 31。
- `ubuntu-cc-02`：Build 28。
- `05`、`06`：管理中心尚无版本记录。
