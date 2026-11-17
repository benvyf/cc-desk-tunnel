# Linux 服务端 Build 29 发布记录

2026-11-17（UTC 18:04）发布到 pilot 通道。只发布软件包与升级指令；未升级任何节点。

| 项目 | 值 |
| --- | --- |
| Build / 协议 / appVersion | 29 / 24 / 0.3.10 |
| 运行时级别 | `node24-cli2.1.325-v5`（Node 24.22.2，官方 CLI 2.1.325，二进制 sha256 `0dc4f4a9…`） |
| 源码提交 | `d84386a4ccf8337321947c871dfda5895b337ac9`（分支 `release/server-build29`） |
| 归档 | `cc-desk-tunnel-server-0.3.10-build29.tar.gz`，大小见公开索引，sha256 `f67574c26f2c5ccd171bca07220a2ecfb39b0a4def99cd0bf336bb84cdcdfec7` |
| 依赖锁 | `a884b488…`（Agent SDK 0.3.325） |
| 公开索引 | pilot revision 50（发布 49 + 强制续期 50），有效期至 2026-12-01 |

## 内容

- 合并已发布 Build 27（`53e7b53`）与 ubuntu-cc/02/03 使用的 Build 28 补丁：原生终端审核检查 CLI 2.1.325 及其二进制哈希（Build 27 仍检查 2.1.295）。
- Agent SDK 0.3.325，及 CLI 2.1.321+ 适配：退出时记录丢失提示、等待 CLI 自行退出、提问“不回答/已在聊天回复”、登录到期提醒、OSC 7501 终端状态、`/compact` 新记录顺序、网关计费提示每日一次。协议不变。
- `apply.py`：准入 Build 27（`be243f26…`）与 Build 28（`2f7fc483…`）为基线；`RUNTIME_LOCK` 为旧依赖，`LOCK` 为 Build 29 依赖；在线容器检查接受 SDK 0.3.286/0.3.325，候选镜像要求 0.3.325。
- `host-operations.py` 目标容器检查接受 SDK 0.3.325（第一次实验构建在此失败后修复）。
- `.dockerignore` 补入 `deploy/host-update/images.py`。
- Web 客户端沿用 Build 27 归档中的构建（与 Build 26→27 做法一致）；main 上之后的 Web 界面改动未包含。

## 验证

- VPS 隔离实验构建（`linux-build29-preparation/build-lab.py`，复用 Build 27 流程）：镜像 643,666,104 字节（上限 3 GiB），基础层、全部文件哈希、真实 PTY 探测、目标容器就绪、切换前 CLI 准入均通过；未切换服务，模型请求 0；实验镜像已清理，生产镜像 ID 不变。
- 发布脚本（复用 Build 27 `prepare.py`/`publish.mjs`，仅改身份与路径）：签名、公网索引与完整下载大小/sha256、续期登记与强制续期、Windows pilot/stable 索引未变、管理中心运行时未变、未创建节点作业。
- 备份：`/var/backups/cc-update-service/server29-publication-20261117T180417Z`。续期 timer 已恢复，服务单元指向 `linux-build29-preparation/source`。
- 未做：真实 CLI 下的新功能实测。建议先升级 `ubuntu-cc-03` 实际使用，再升 02、ubuntu-cc。

## 节点（发布时）

ubuntu-cc、ubuntu-cc-02、ubuntu-cc-03 均为 Build 28、空闲。04–06 未登记主机升级。

2026-11-16 ubuntu-cc 升级 Build 27 失败（镜像层解包 crc32 校验错误），发生在同日磁盘由约 29 GB 扩容到 44 GB 之前；扩容后 Build 28 构建正常。
