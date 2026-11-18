# 跨协议过渡版的两通道发布（方案 A）

2026-11-18 用户选定。目标：工作空间服务端升级到新协议后，旧客户端无需拿下载链接，一键在应用内更新；没来得及升到过渡版的客户端也始终有路可走。

## 两个通道各放一个安装包

签名索引每个通道只有一个 `release`，已安装客户端按严格格式校验，不能在同一索引里放两个包。因此借用既有的两个通道：

| 通道 | 内容 | 读取者 |
|---|---|---|
| pilot | 过渡版（协议 24），长期保留并续期 | 尚未升到过渡版的旧客户端：同协议自动更新到过渡版 |
| stable | 最新版（协议 25 起） | 过渡版及以后的客户端（内嵌通道为 stable）：工作空间要求协议 N 时，在应用内一键更新（[强制规则第二节第 6a 条](UPDATE-RELEASE-RULES.md)） |

过渡版构建时 `deploy/managed-client.json` 的 `channel` 为 `stable`。旧 pilot 客户端从 pilot 装上它后，新构建按自身身份读取 stable，更新账本按通道分开（`ledger-stable.json`），同一安装的 `pending.json` 照常确认。

代价：pilot 不再用于新版本的试点验证，只承载过渡版。之后若需要试点，需另增通道名，涉及客户端与更新服务改动。

## 发布顺序

发布期间先停两个续期 timer（`systemctl stop cc-update-renew.timer cc-update-renew-stable.timer`），发布并登记后再启用，避免续期撞上未完成的候选。

1. **先提交本次发布脚本与续期脚本的跨通道修改，再构建过渡版**：续期要求 pilot 检出的 HEAD 等于过渡版的 sourceCommit，脚本修改必须已在过渡版的构建提交里，否则 pilot 续期会在差分校验处失败，只能重出 build。构建过渡版（协议 24，channel=stable），按发布门槛验证真实 EXE（`scripts/verify-managed-client.mjs`），并在打包 EXE 上手动走通：管理中心 426、远程 `version_mismatch`、local 直连、稍后更新后重连。
2. **先发布到 stable**（此时还没有读者），核对公开 stable 索引有效。stable 当前为过期的 empty 索引，若先发 pilot，已升到过渡版的客户端读 stable 会报有效期错误。
3. 再把同一已登记制品发布到 pilot（更新服务支持复用已知制品；发布脚本只允许「构建自身通道」或「内嵌 stable 的过渡版发到 pilot」这一种跨通道组合，且在上传前检查）。两个通道的差分描述文件都以构建自身通道 stable 签名：pilot 上的旧客户端会判定差分不适用、改为完整下载，属预期。
4. 两个通道各自登记续期并立即写入新的 `expectedRelease`（见下），随后各以 `--force` 手动运行一次两个续期服务验收：revision 递增、另一通道字节不变、候选数为 0。等待正常运行一段时间，确认旧客户端经 pilot 升到过渡版、过渡版读取 stable 正常。
5. 协议 25 分支并入过渡版改动，构建最新版（channel=stable），只发布到 stable，并更新 stable 的续期登记；pilot 保持过渡版。
6. 管理员在各 Ubuntu 节点做镜像升级。客户端连接时收到 `requiredProtocol`，一键更新到最新版；仍是旧版的客户端先经 pilot 自动升到过渡版，再一键更新。

**Build 号规则：** 新 build 必须高于跨通道已保留的最大 build。过渡版用较低 build，最新版用更高 build。**若之后要修过渡版**，新过渡版 B′ 必须高于 stable 上的最新版 N；装上 B′ 的客户端读 stable 时 N < B′，不会出现更新。所以每次重发过渡版后，都必须以更高 build 重发 stable 最新版。

## 两个通道的续期

索引有效期 3 天，必须分别续期，否则过期索引会阻止安装：

- pilot：既有 `cc-update-renew.service/.timer`，配置 `/root/.cc-update-admin/automation/config.json`，`expectedRelease` 改为过渡版。
- stable：新增 `deploy/update-service/cc-update-renew-stable.service/.timer`（UTC :40，晚 pilot 20 分钟，并排在 pilot 服务之后），配置 `/root/.cc-update-admin/automation-stable/config.json`，其中 `"channel": "stable"`、`expectedRelease` 为 stable 当前发布；状态与证据写入 `automation-stable/`，快照写入 `CURRENT-RELEASE-stable.json`。

`renew-managed-index.mjs` 按配置的 `channel`（缺省 pilot）续期，并核对另一通道在续期前后字节不变；配置文件所在目录必须与通道一致（`automation/` 对应 pilot，`automation-stable/` 对应 stable），否则拒绝运行。

两个通道各需一份**独立的干净源码检出和制品路径**：续期调用的是配置中 `source` 目录里的发布脚本，并要求其 HEAD 等于该通道当前发布的 sourceCommit。步骤 5 之后两个通道的提交不同，不能共用检出；pilot 的检出必须包含本次发布脚本的跨通道修改。部署到 VPS 需管理员执行，本仓库改动不会自动生效。
