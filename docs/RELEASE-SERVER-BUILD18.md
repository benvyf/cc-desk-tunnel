# Linux Build 18：终端运行依赖检查

2026-11-06，香港时间。当前 Linux pilot 更新入口为 Build 18 / 0.3.10 / 协议 24，配套 Windows Build 31。发布未替用户安装 Ubuntu 更新。

## 行为与恢复范围

03 的本地 Build 16 镜像中，node-pty 同版本的 terminal.js 有一个字节异常，打开终端时触发语法错误，服务崩溃三次后被启动预算锁定。用户已恢复容器内文件并备份、重置计数，服务健康恢复；底层旧镜像仍有异常。异常字节来源尚未确定，不能宣称已排除存储或内存问题。

Build 18 的宿主机入口从签名源码重新执行 npm ci 构建镜像，不复制旧 node_modules。构建时实际创建 PTY 并生成 node-pty 的 JS、原生 addon 及可选 spawn-helper 摘要清单；安装前隔离校验并创建 PTY；每次服务启动校验依赖摘要，异常时明确报告文件。崩溃三次的保护保留，日志明确锁定原因和 journal 路径，不自动无限重试或清除计数。

沿用默认有引用保护的空间清理、预算检查、空闲校验、受控断开、冷备份、健康检查、失败回退及必要冷备份轮转。精确准入 Build 16 的原描述符；不恢复旧会话库，不改变账号、审核和 Ubuntu 模型出口。

在管理中心刷新后新建 **Build 18** 升级任务，建议先验证 03 的终端，再逐台更新其他节点。占用中的终端和运行/等待任务会阻止切换；普通空闲客户端由流程受控断开。已安装协议 24 的客户端可以配套使用，Build 31 提供新的窗口诊断日志。

## 发行身份与验证

- 源码 `90d50f2f357aaecf0f0b1b837a9846507c1dba32`；runtime `node24-cli2.1.295-v3`，Node/CLI/SDK 版本保持。
- [完整签名归档](https://api.ghostapi.org/cc-updates/server/v1/artifacts/18/linux-x64/cc-desk-tunnel-server-0.3.10-build18.tar.gz)：8,109,616 字节；SHA256 `9d33864c90366daca4ad6d2c4e16a485085c0fcc20e3af7e9a7d2173947da980`。[公开发行证据](evidence/linux-build18-production-2026-11-06.json)。
- pilot revision 30；236 文件签名清单、公开完整下载摘要及本机独立索引验签/本地制品身份一致性核验通过。
- 真实公开签名索引已通过签名包内迁移的版本、运行级别、lock 和摘要准入；现行 agent 对三台已读 Build 16 节点选择正确宿主机入口。无生产安装任务创建。
- Linux 隔离迁移/清理/备份保护测试 40/40；首次安装测试 7/7。Node 24.22.2 的隔离 Ubuntu 真实 PTY、普通用户 probe 和单字节损坏拒绝通过；Docker 升级切换使用替身，不等同于生产节点升级验收。
- 相关核心首批 76 项通过；运行级别修正后相关合约/发布/启动预算测试 32 通过、1 Windows 条件跳过；类型检查通过。不启动 Claude 或真实模型请求。
- 精确续期已登记，真实 systemd 服务成功，两套 timer active。Linux 续期使用 `/etc/systemd/system/cc-server-index-renew.service.d/runtime18.conf`，固定执行本次干净源码中的发布工具，避免引用管理中心旧编译运行级别。该只读源码目录不得随意清理：`/root/.cc-update-admin/linux-build18-preparation/source`。
- 发布备份 `/var/backups/cc-update-service/server18-publication-20261106T102346Z`。管理中心运行文件未修改、未重启；Windows Build 31 和 stable 保持，三节点版本/作业保持。

## Build 17 的边界

Build 17 曾短暂发布，但旧发布工具将运行级别写为 v2，而签名迁移要求 v3，安装会安全拒绝。没有创建节点安装任务，已用更高 Build 18 替代，旧归档不覆盖。Build 18 同时绑定打包身份与发布工具运行级别，并在发布前及发布后验证真实签名的安装准入；仅验证 agent 选中了脚本不再作为充分证据。历史记录见 [Build 17 证据](evidence/linux-build17-production-2026-11-06.json)。
