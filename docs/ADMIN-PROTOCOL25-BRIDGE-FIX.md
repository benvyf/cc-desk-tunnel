# 管理中心放行协议 25 的 legacy 接入（Linux Build 30）

2026-11-18（UTC 14:59），经用户同意上线。Linux Build 30（协议 25，`node24-cli2.1.325-v5`）发布后，尚未接入宿主机平台的 legacy 节点（ubuntu-cc、02、03）只能经管理中心宿主机工作流（`POST /cc-updates/admin/api/host-workflows/:node`）升级；普通设备任务在 `apply.py:618` 申请接入时被拒（无 legacy bridge 工作流），而工作流确认又被 `supportsLegacyBridge` 以 `Legacy adoption requires a supported signed bridge runtime.` 拒绝：11-16 的 [Build 26 修复](ADMIN-BUILD26-BRIDGE-RUNTIME-FIX.md)只放行 v5 / 协议 24 / Build 26+。

## 修复

只改实际运行中心的 `apps/update-service/src/host-updates.ts` 中 `supportsLegacyBridge`：在原规则外只增加 v5 / 协议 25 / Build 30+（[补丁](../patches/center-protocol25-bridge.patch)）。v4 规则（原本即不检查协议）、v5 / 协议 24 / Build 26+、调用点（工作流确认与仅限保留任务的 failed 入队）不变。修改前 SHA256 `ae42241f82b51873d21befcdded2f0436793120ee74ffa0ff3c9e5a39eb10d15`，修改后 `371b1e0f21f582d4c714007ca57b1c8a23ff2c87430d1283e97488a0d772bd5c`；BUILD-INFO 同步更新并追加 overlay 记录。

Fable 5.2 复核：无阻塞；中心与节点端（host-updater-agent / host-worker / host-bootstrap / host-operations，以及 Build 30 归档内的脚本）没有第二处拒绝 24 → 25 的协议常量。

## 验证与上线

- [隔离 HTTP 回归](../scripts/test_center_protocol25_bridge.mjs)（由 Build 26 版本改写）：读取真实签名的 Build 30 与 agent 索引，临时 SQLite、合成凭据、回环端口。原代码复现 409；补丁后 6/6 通过（含 29/p25、30/p26、v6 拒绝，篡改签名/错误目标/未授权/错误 Origin 拒绝）。上线后以实际运行目录再跑 6/6 通过。
- 冷备份 `/var/backups/cc-update-service/center-protocol25-bridge-20261118T145955Z`；重启中心，4 个签名索引（Windows pilot/stable、Linux pilot、agent）逐字节不变。

## ubuntu-cc-03 升级结果

- 前置：节点 Build 28 是绕过工作流手动安装的，`/data/managed-server/journal.json` 不存在。监督程序把缺失视为默认空闲日志，但 `apply.py` 的 `VERIFY_RUNTIME` 与宿主机程序的恢复检查要求文件存在。经用户在节点上以业务用户写入监督程序的默认日志（`{"schema":1,"phase":"idle","current":null,"previous":null,"target":null,"backup":null,"attempts":0}`，`wx` 不覆盖）。
- 工作流 `20de30d9…`：应用任务成功，`UPGRADE_OK: Linux Build 30 / protocol 25`，完整冷备份已校验，回退命令 `sudo python3 /var/lib/cc-runtime-upgrade/backup-20261118T150442Z-51ee9227/rollback.py --rollback /var/lib/cc-runtime-upgrade/backup-20261118T150442Z-51ee9227`。`RETENTION_PENDING`（一份约 30 MB 旧备份未清理）不影响服务。
- 切换会重建 `/data/managed-server`，新容器同样没有 journal，接管阶段进入 maintenance-required；再次写入默认日志后取得新的修复证明，以 `retryOf` 继续（工作流 `3b478f09…`），**接管成功：registration ready，agent v1 已提交**。

## 后续

1. **源码修复（下一 Build）**：`apply.py` `VERIFY_RUNTIME` 及宿主机恢复检查应把不存在的 `journal.json` 视为默认空闲日志，或在切换后写入；否则每次镜像切换后都需人工补写。
2. ubuntu-cc：旧工作流卡在 maintenance-required，原因同上；补写 journal 后可尝试以 `retryOf` 继续到 Build 30。
3. ubuntu-cc-02：升级前先补写 journal。
