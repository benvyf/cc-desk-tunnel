# 服务端账号管理正式发布（2026-10-24）

用户授权部署后，VPS 控制中心已上线账号编号与邮箱映射，同时向现有 pilot 通道发布 Windows Build 6、Linux Build 3。版本0.3.6，协议20，发布源码 `224d7bcae1e4d1e1f37a8b72bfdb3d48cfacaa6a`。后续文档提交不是制品源码身份。

客户端账号界面显示编号，移除 Claude 登录/退出操作；配套服务端拒绝远程账号登录操作并投影账号身份。账号登录、退出和换号由用户在 Ubuntu 通过官方 Claude Code 处理，当前已登录账号无需重新授权。操作说明见 [服务端账号管理](SERVER-MANAGED-ACCOUNTS.md)。

## 已上线制品

| 制品 | 身份 | 大小（字节） | SHA256 |
| --- | --- | --- | --- |
| Windows x64 完整安装包 | Build 6，pilot revision 11 | 201081223 | `c3ba7aa38198adbd728ee39919edcea2d4162303b9db2db6d864e27fece77e85` |
| Linux x64 完整程序包 | Build 3，pilot revision 5 | 1569200 | `55bc3834b8f4be34974b203edc360e6b4ea2a17abedf36af6acfba0b9eee713c` |
| 控制中心运行包 | 43个运行文件 | 112391 | `a96c03e5466fa325b59196c705713f1af4a88c60deaabb0f9dde60fb313fdb83` |

- [Windows Build 6 下载](https://api.ghostapi.org/cc-updates/v1/artifacts/6/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe)
- [Linux Build 3 程序包](https://api.ghostapi.org/cc-updates/server/v1/artifacts/3/linux-x64/cc-desk-tunnel-server-0.3.6-build3.tar.gz)（由受管升级安装）
- [控制中心账号监控](https://api.ghostapi.org/cc-updates/admin/monitor)

stable 空通道保持原字节。Windows/Linux 续期登记均绑定上述源码与精确制品，两 timer 已恢复 active，续期 oneshot 各执行一次成功并返回 not-due。发布时 revision 是快照，后续续期可递增 revision。

## 用户操作与后续结果

以下为发布时交付的安装步骤。用户随后回传 `SUCCESS: Linux Build 3 / protocol 20 is installed and committed.`，首台 Ubuntu 已完成升级，无需重复执行；重新连接后的编号显示待反馈。控制中心后续已上线独立的“已接入服务端升级”命令，今后从“客户端更新”页复制即可，当前运行源码为 `d63607d1401bd84c0d1724488533190913031e64`。Windows6／Linux3的制品源码仍为本文开头的 `224d7bc…`；部署证据见 [升级入口](evidence/control-center-server-upgrade-2026-10-24.json)。

1. 安装 Windows Build 6。
2. 结束任务，完全退出所有 CC 连接，包括托盘连接。
3. 打开 [Ubuntu 升级命令文件](ubuntu-build3-upgrade-command.txt)，整行复制到首台 `ubuntu-cc` 控制台执行。命令使用现有容器与 env-file，在容器 loopback 管理接口请求精确 Build 3；不需要首次 bootstrap。脚本可读源码见 [upgrade helper](ubuntu-build3-upgrade.cjs)。
4. 保持终端打开，每15秒显示等待进度；等待 `SUCCESS: Linux Build 3 / protocol 20 is installed and committed.`。HTTP 409 表示忙碌或未通过安装准入，保留输出定位，不绕过保护。异常时先核对受管状态，不重复执行首次安装器。
5. 重新连接客户端，确认账号编号和控制中心邮箱对应。现有 Claude 登录应继续使用，不为验收重新登录或主动发测试会话。

开发环境无该 Ubuntu 的 SSH 管理入口，实机升级由用户在控制台执行并回传成功，开发工具没有直接操作该节点或替用户安装 Windows 客户端。其余五台保持暂缓。

## 验证与恢复依据

源码74项相关回归、TypeScript、前端构建和模拟账号 UI 已通过。正式 Windows 包通过实际 EXE/preload/随包组件关闭测试。正式 Linux 归档154个文件逐项校验，在无网、无账号、只读 Docker 中验证 Build 3／协议20、health、readiness、SIGTERM 和零 CLI sentinel；控制中心实际运行包在 Linux 隔离环境通过17项相关测试。

发布工具从公网完整下载 Windows 和 Linux 并核对摘要；随后固定生产公钥验证公开索引签名，核对 Windows HEAD/Range、Linux 完整摘要、线上 app.js 与源码字节一致、未登录监控接口401及 stable 空通道。升级 helper 的本地合成测试5项通过：成功提交、409忙碌、目标不匹配、回滚、重复执行已安装识别。没有启动真实 Claude/SDK 会话或调用 JEV/额度接口。

VPS 运行、业务数据、配置及续期登记备份：`/var/backups/cc-update-service/account-display-20261024T041203Z`。旧运行目录：`/opt/cc-update-service.previous-account-224d7bc`。配置、管理员凭据、审核策略未改；私钥与令牌仅留 VPS。本次源码完整 Git bundle 位于 VPS 发布目录，GitHub 尚未推送。原 Ubuntu 首次接入与 CLI 恢复备份继续保留，不能用本次 VPS 运行目录回滚代替 Ubuntu 受管回滚。

脱敏证据：[生产发布记录](evidence/account-mode-production-release-2026-10-24.json)。VPS 原始发布目录：`/root/.cc-update-admin/account-release-224d7bc`；本地正式制品：`.local/account-release-build6/artifacts/`。
