# Windows Build 32 / Linux Build 19

2026-11-07，香港时间。两端均为 CC Space 0.3.10 / 协议 24，发行源码 `86cdb0020eb684e474d6d60d0cb6cea6b14c4b6f`。已更新 VPS 管理中心的 pilot 安装包与服务端升级入口；用户明确要求自行执行 Ubuntu 升级，本轮没有创建或执行节点安装任务。

## 本版内容与使用

吸收上游的 Windows scp/sftp 盘符修正、上下文窗口统计、终端记录增量同步、本地命令及手动压缩显示、Git Bash 检测和按设备 Shell 偏好，以及会话专属 SSH 包装器。包含两轮 review 的父链/迟到回答、配置 PATH、状态采样错误及 Provider 文件缺失修复。不含 CCDT、缓存过期提醒或空闲自动压缩。Claude、SDK、账号与模型出口始终在 Ubuntu。

先刷新[管理中心更新页](https://api.ghostapi.org/cc-updates/admin/updates)，在相应 Ubuntu 节点获取 **Build 19** 的新升级任务/指令，由用户执行；再从客户端内检查更新获取 **Build 32**。不要重试旧 Build 17/18 的任务指令，也不需要重复首次接入或重装。升级入口仍只准入已审查节点，不为其他节点新增授权。

Build 19 在新签名包中绑定新版 `deploy/host-update/apply.py`，保留 Build 16 等既有精确基线，并新增已发布 Build 18 的描述符、依赖锁和运行时精确准入。默认流程保留带引用保护的清理、构建前后空间预算、空闲校验、受控断开、冷备份、切换与健康检查、失败恢复和上一套必要回退轮转。运行/等待任务或占用终端会阻止切换；空闲客户端由流程断开，不要求逐个手动关闭。不改账号、项目、会话数据或管理员策略，不升级 Claude/SDK。

## 制品与发布核验

| 制品 | 大小 | SHA256 |
| --- | ---: | --- |
| [Windows Build 32 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/32/win32-x64/CC-Space-Setup-0.3.10-x64.exe) | 258,611,536 | `dfe45ad06f27bc3930df4b1211c41ae9c00b3d5885a5095a7b998381ac511450` |
| [Linux Build 19 签名归档](https://api.ghostapi.org/cc-updates/server/v1/artifacts/19/linux-x64/cc-desk-tunnel-server-0.3.10-build19.tar.gz) | 8,127,118 | `708e3e416324a87c5396235d7c88bd04fe1e5d9a4e552b0555deff05c55e24b1` |

- Windows 真实 EXE 离线启动与随包组件退出通过；真实安装包压缩流检查、解包后的 app.asar 与构建产物一致。28 个主进程模块、691 个组件逐项匹配，包内保留控制器、preload、固定签名身份、更新 UI 与完整包入口，没有模型 SDK。
- 更新核心 49 项、更新 UI 24 项通过。UI 使用此前适配 SSH API 的隔离夹具；其中完整包入口使用真实公开已验签索引经过实际控制器生成的状态，并检查截图。覆盖登录前/断开、同协议更高 Build、跨协议提示与获取、拒绝跨协议自动安装、查看后提醒保留、失败重试和当前 Build 无更新。
- Linux 断网隔离容器中，迁移、清理与备份轮转 30 项、首次安装 7 项、bootstrap/受控断开/失败恢复 32 项通过。签名归档 236 文件逐项检查；发布前真实签名预览和发布后公开签名均通过新升级入口的实际准入。
- 现行生产 agent 在临时目录真实下载、验签并解包新版，对三台已读 Build 16 及 Build 18 状态均选中 Build 19 的宿主机升级入口。只替换本地状态探测；没有执行该安装命令或操作生产 Docker。
- 两端公开索引独立验签，与本机实际安装包/归档摘要一致；VPS 完整公开下载摘要通过。Windows pilot revision 48，Linux pilot revision 32；后续定时续期可以继续递增 revision，Build 与制品保持不变。
- 精确续期登记已更新，Windows 源码固定 `/root/.cc-update-admin/source-build-32`；Linux 固定 `/root/.cc-update-admin/linux-build19-preparation/source`，新增 `runtime19.conf` systemd 覆盖。两端强制续期及真实 systemd 单元执行成功，两个 timer active。上述干净源码为运行引用，不能清理。
- 管理中心沿用线上程序，未用主分支整体替换或重启；全部运行文件 inventory 及 stable 原字节保持。旧公开脚本、旧安装包、公钥、安装身份、节点授权不变；六节点当前版本和原有作业核对一致。三台已接入节点仍上报 Build 16，03 的既有 failed phase 未在本轮改写。

发布备份：`/var/backups/cc-update-service/server19-publication-20261107T064221Z`、`/var/backups/cc-update-service/client32-publication-20261107T064246Z`。配置/索引保留独立备份，旧公开制品不原位覆盖。[结构化证据](evidence/release-client32-server19-2026-11-07.json)。

## 验证边界

没有真实模型调用、生产节点安装或用户日常客户端安装。Docker 切换/恢复采用隔离替身，不冒称完成用户 Ubuntu 的实机升级。此前官方 CLI/SDK 的受控执行通道验证见[上游吸收实施记录](UPSTREAM-0.3.13-ADOPTION-STATUS.md)。

隔离验证曾因容器缺少 Python 完整标准库、Node/Git 或以非 root 运行首次安装夹具失败/跳过，补齐环境后重验。额外 bootstrap 回归发现旧夹具把 HEAD 当作原镜像持久化基线；仅修正测试夹具中的基线和原运行级别，并显式验证拒绝运行级别 3；最终 32 项通过。不修改产品准入、不改已发布制品。
