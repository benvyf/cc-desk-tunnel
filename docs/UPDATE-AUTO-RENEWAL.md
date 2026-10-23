# VPS pilot 自动续期

2026-10-23 已按用户授权部署。任务由 VPS 自己运行，不依赖开发电脑或 Codex 在线。

## 运行规则

- `cc-update-renew.timer` 已启用并设为开机恢复，每天 UTC 00:20、06:20、12:20、18:20 检查，随机延迟最多五分钟；香港时间为 08:20、14:20、20:20、次日 02:20。
- 当前 pilot 索引剩余有效期大于两天时跳过；不足或等于两天时，调用既有发布工具，增加 revision 并续签三天。
- 登记的制品为 build 2 / 0.3.6 / 协议 20。签名、完整安装包下载/hash 校验、候选清理和公开索引核对沿用现有工具。stable 通道不变，不调用 Claude。
- 索引被撤回为空时保持撤回，不重新发布。当前制品与登记信息不同、存在未完成候选、签名或发布检查失败时，服务失败并保留证据，不继续激活旧包。
- VPS 停机期间错过检查，开机后 systemd 会补运行；管理员续期脚本可以在签名签发时间验证过期索引并重新续签。客户端仍须按当前时间验签，不接受过期索引。

## 文件与维护

| VPS 路径 | 用途 |
| --- | --- |
| `/opt/cc-update-renewer/scripts/renew-managed-index.mjs` | 自动续期入口，对应仓库同名脚本 |
| `/opt/cc-update-renewer/packages/managed-updates/src/index.ts` | 与仓库一致的签名契约 |
| `/root/.cc-update-admin/automation/config.json` | root 0600；固定源码、安装包和预期 release |
| `/root/.cc-update-admin/automation/last-run.json` | 最近检查状态：not-due、withdrawn、renewed 或 error |
| `/root/.cc-update-admin/automation/runs/` | 每次续签的模板、签名索引、发布证据及结果，root 专用 |
| `/root/.cc-update-admin/CURRENT-RELEASE.json` | 最近成功续期快照；实时状态以 API 为准 |
| `/etc/systemd/system/cc-update-renew.service`、`.timer` | systemd 服务和日历任务，对应仓库 deploy 文件 |

凭据仍保存在既有 `/root/.cc-update-admin/signing/` 和 `access/`，不写入 unit、仓库或日志。发布时继续使用干净的 `/root/.cc-update-admin/source-build-2`；部署续期脚本没有修改此 checkout。生产更新服务及其运行账号不变。

查看状态和日志：

```sh
systemctl list-timers cc-update-renew.timer --all
systemctl status cc-update-renew.timer cc-update-renew.service --no-pager
journalctl -u cc-update-renew.service -n 30 --no-pager
cat /root/.cc-update-admin/automation/last-run.json
```

oneshot 服务成功执行后显示 inactive/dead 是正常现象，应结合 `Result=success`、退出码及 timer 的 active/enabled 判断。失败原因的阶段写在 last-run 和 journal，发布证据在 runs；未配置额外的消息通知。

暂停及恢复：

```sh
systemctl disable --now cc-update-renew.timer
systemctl enable --now cc-update-renew.timer
```

手动执行一次普通检查：

```sh
systemctl start cc-update-renew.service
```

之后发布新 build 或调整发布说明前，先停止 timer 并等待正在运行的 oneshot 结束，再按已有流程发布。核对新签名 release 后，将 `automation/config.json` 中的 `source`、`artifact`、`expectedRelease` 更新为实际新版本；不要在运行期间改写此文件，也不要修改旧 build 的制品身份。重新启用 timer 并执行一次检查。跨电脑只需通过授权 SSH 操作这些 VPS 文件。

## 部署验收

2026-10-23 14:11（香港时间）使用同一 systemd 服务临时加入 `--force` 执行真实续签，pilot revision 4 升至 5，有效期至 2026-10-26 14:11:43（香港时间）。公开安装包完整校验通过，release 全字段与原版相同，stable 字节未变，候选清理为 0。临时覆盖已移除，正式 ExecStart 不带 `--force`；随后再次执行服务，返回 not-due，未重复发布。

timer 实测 active、enabled，首次计划检查为 2026-10-23 14:22:24（香港时间）。部署时未等待这个未来触发点；通过真实服务验收及日历核对确认配置生效。`systemd-analyze verify` 通过，线上脚本/契约/units 的 SHA256 与仓库文件一致。本机另行核对实时 HTTPS 索引的固定公钥签名、与 VPS 签名文件的逐字节一致性、旧 revision 4 ledger 接受 revision 5，以及 build 2 仍为 current。

三项核心单元测试覆盖到期决策/强制验收、撤回及版本变更拒绝、过期真实签名恢复及错误签名/未来签发拒绝。证据在本机 `artifacts/update-auto-renew-20261023/` 和 VPS `automation/runs/2026-10-23T06-11-42.995Z/`。该目录仅保留公开索引和脱敏结果，没有复制生产私钥或管理令牌。
