# Build 26 创建设备更新任务被 v4 接入限制拒绝

2026-11-16，香港时间。用户点击管理中心“更新设备”收到 `Legacy adoption requires the signed v4 bridge runtime.`。本轮已定点修复上线，源码补丁提交 `a77e3efa9097731826adbcef72bbd5370140585c`，没有下发 Ubuntu 安装任务。

## 原因与定点修复

Build 26 已公开签名并验证，运行身份为 `node24-cli2.1.325-v5`。上一轮验证了迁移脚本、agent 选路和目标版本展示，但没有实际执行 UI 对应的 `POST /cc-updates/admin/api/host-workflows/:node`，遗漏了中心 HostWorkflows.confirm 的 v4 限制。用户这次请求在创建设备任务之前被 409 拒绝，不是磁盘空间问题，也没有进入 Ubuntu 停机流程。

修复只涉及中心两个模块。HostUpdates 导出共用的 supportsLegacyBridge：保留原签名 v4 / Build 22+ 的准入，并允许确切的 `node24-cli2.1.325-v5` / 协议 24 / Build 26+；未知 v5、v6、较低 Build 或不匹配协议仍拒绝。HostWorkflows.confirm 和仅限保留任务的 failed-preparation 内部入队使用同一规则，不开放普通 failed 状态入队。

签名发行查询、管理员认证、Origin、用户明确确认、agent 与应用精确版本/摘要、忙碌任务、回退限制、保留权和历史诊断规则不改。Linux Build 26 归档、签名索引、续期、旧公开脚本和设备版本/既有任务不改，不生成新 Build 或替换已发布包。

完整中心包含本分支未收录的现行宿主机模块，修复基于实际运行目录的 BUILD-INFO 清单逐文件校验后制作最小 overlay；不把本分支当作完整中心源码直接部署。[精确补丁](../patches/center-build26-v5-bridge.patch)保留两个原模块的上下文，可用于同一实际基线。修改前 SHA256：host-updates.ts `98c80a02a443e7bc55c2f5d29666d33173b7a78a8ab8cdac7248a5825543a70f`，host-workflows.ts `379552fccaa7af6bec40fe938897b59f90dd9d05c0e5d618595758a7cc2b2889`。

## 验证

[隔离 HTTP 回归](../scripts/test_center_legacy_bridge_runtime.mjs)以 CC_CENTER_SOURCE 指定完整的实际中心副本，CC_BRIDGE_TEST_ROOT 指定私有测试目录；读取当前公开签名 Build 26 与 agent 索引/制品，使用独立临时 SQLite、合成管理员和节点凭据，只监听回环临时端口。没有复制生产账号数据或连接生产 worker。

原代码通过相同 HTTP 请求复现用户的 409，且没有入队任务。补丁后 6 组回归通过：真实签名 Build 26 创建精确关联的唯一任务、重复确认不重复入队；运行身份/Build/协议边界；预备失败状态仅放行保留的接入任务而普通入队仍拒绝；旧 v4 正常；未知已签名运行身份拒绝；修改签名、错误目标、未授权及错误 Origin 均不入队。下游已发布 worker 未发现另一个 v4 运行身份限制。

## 上线结果

基于实际运行版本仅替换 host-updates.ts 和 host-workflows.ts，更新 BUILD-INFO 的两个摘要及 overlay 来源。私有目录冷备份后短切换 1.568 秒，备份 `/var/backups/cc-update-service/build26-v5-bridge-20261116T081148Z`；配置和密码数据不变。修改后 SHA256 分别为 `ae42241f82b51873d21befcdded2f0436793120ee74ffa0ff3c9e5a39eb10d15` 与 `19436fcb377dbe665f9dbe8ea3fcfe73120e1d8cb03f40758236a7614760f457`。

以部署后的实际模块再次运行隔离 HTTP 接口的 6 组回归通过。生产 GET 工作流接口返回 ubuntu-cc 的目标为 Build 26 / `e4ff9d10c281758a31a434bc713c74d04bd8c1329b3ffcc6b965a1e55845a5c3`。Linux、Windows pilot/stable 和 agent 四个签名索引逐字节保持，公开 Build 26 全量下载/hash 保持；管理中心和两个续期 timer active，六台节点的版本及原任务不变。无真实模型请求或生产任务创建。[核验证据](evidence/admin-build26-v5-bridge-2026-11-16.json)。

修复后用户需刷新管理中心，重新明确确认 Build 26。重启中心会使浏览器密码登录会话失效，必要时重新登录即可，不能重置节点接入或 Claude 账号。
