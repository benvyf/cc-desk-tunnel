# VPS 统一发布与跨电脑凭据

> 当前已发布 Windows Build 5／Linux Build 2，两套自动续期均已登记并启用。本文包含历史身份迁移记录；当前源码恢复、管理入口、运行路径和发布边界见[开发交接](../DEVELOPMENT-HANDOFF.md)，不要从普通 GitHub clone 假定已取得当前工作分支。

2026-10-23 起，生产发布身份由 VPS 集中保管。旧电脑身份 `managed-2026-10-23` 退役，新身份为 `managed-vps-2026-10-23`；旧 build 1 没有发布，保留作历史制品，新公钥从 build 2 开始固定。

build 2 已发布并于 2026-10-23 自动续期部署验收中升至 pilot revision 5，当时有效期至 2026-10-26 14:11:43（香港时间），后续 revision 和有效期由 VPS 自动更新；stable 保持 revision 2 空通道。制品和验收证据见 [正式发布记录](UPDATE-CLIENT-BUILD-2.md)，定时规则、日志及暂停/恢复见 [自动续期](UPDATE-AUTO-RENEWAL.md)。

## 去哪里找

VPS：`74.82.201.214`，管理员 SSH 登录后查看 `/root/.cc-update-admin/`。

| VPS 路径（相对此目录） | 内容 |
| --- | --- |
| `signing/managed-vps-2026-10-23.pem` | 生产 Ed25519 私钥，留在 VPS 签名 |
| `signing/managed-vps-2026-10-23.pub.pem` | 公钥副本 |
| `identity-public.json` | 更新源、公钥 ID 和公钥，可复制到开发电脑 |
| `access/admin-token.txt` | 管理网页/API 令牌，按需经管理员 SSH 读取，不放聊天或 Git |
| `access/admin-token-sha256.txt` | 令牌 hash |
| `backup/` | 身份切换前配置和通道记录，含私有配置，仅管理员可读 |
| `release-input/`、`release-output/` | 发布模板、签名索引、发布证据 |
| `rotation-evidence.json` | 身份生成和配置切换的脱敏证据 |
| `CURRENT-RELEASE.json` | 本次发布完成后的通道、制品和证据位置快照；实时状态仍以发布 API 为准 |

目录为 root 所有、0700，凭据为 0600。它位于站点和更新服务数据目录之外；更新服务仅有公钥及令牌 hash，运行账号 `ccupdates` 和 Nginx 账号不能读取私钥。SSH 主机 ED25519 指纹为 `SHA256:Q7TmQOsYoY+V4agj8p2bwHx5qICS3gBqt0NIan/38to`，保留主机校验。

新公钥 SPKI DER SHA256：`56bad505a7db8ee6e225fc3634b7501409241cea0869a3b9d8074092d0eeeaad`。仓库中 `deploy/update-service/production-public.json` 和 `deploy/managed-client.json` 仅含公开身份。

## 换电脑继续

开发、测试和打包使用交接 Git bundle 恢复的完整当前工作分支，不需要生产私钥；当前 GitHub 尚未包含该分支。新电脑需要一个获授权的 SSH 登录身份；本机 SSH 密钥不能从 GitHub 自动获得。当前电脑使用 `C:/Users/benben/.ssh/vps_bandwagon_ed25519`。

发布时把安装包、发布模板及干净源码传到 VPS，然后通过 SSH 执行签名与现有发布 API。私钥和令牌无需下载到各台电脑。生产服务源码 `/opt/cc-update-service` 与发布用源码分开。

Windows 构建后，在对应的干净源码 checkout 创建 Git bundle：

```powershell
git bundle create D:/release/source.bundle HEAD
scp -i C:/Users/benben/.ssh/vps_bandwagon_ed25519 D:/release/source.bundle root@74.82.201.214:/root/.cc-update-admin/release-input/
```

同样上传精确对应的 EXE 和模板。在 VPS 上将 bundle 克隆到新的源码目录，使用 bundle 指向的完整提交，不修改该 checkout。Git bundle 不包含未提交改动、依赖或本机凭据。发布工具只使用 Node 内建模块，无需在 VPS 安装 npm 依赖。

```sh
git clone /root/.cc-update-admin/release-input/source.bundle /root/.cc-update-admin/source-build-N
cd /root/.cc-update-admin/source-build-N
/opt/cc-update-runtime/bin/node scripts/publish-managed-update.mjs \
  --input /root/.cc-update-admin/release-input/pilot-template.json \
  --source /root/.cc-update-admin/source-build-N \
  --artifact /root/.cc-update-admin/release-input/CC-Desk-Tunnel-Setup-0.3.6-x64.exe \
  --out /root/.cc-update-admin/release-output/pilot-NEW.json
```

模板遵循 [签名输入格式](UPDATE-SIGNING.md)，不填写 size/sha256。工具读取线上管理状态，自动提高该通道 revision、更新签发时间和三天有效期；核对生产公钥及源码 build，调用现有签名 CLI，再通过 API 创建候选、上传、激活。最后核对公开索引字节、完整下载的安装包大小/hash，并确保另一个通道未变化。输出及 `.evidence.json` 保存在 VPS；每次使用新的输出文件名。失败时查看证据中的 candidateId，按管理页处理未完成候选，不删除数据库记录或改用同 build 的不同安装包。

激活后候选记录仍会保留；确认发布完成后可在管理页删除该候选，公开索引和已发布制品不受影响，避免八个候选名额用尽。

签名空索引使用 `state: empty`、`release: null` 模板，只传 `--input` 和 `--out`。它会改变指定通道，必须属于当次明确发布/撤回安排。续期遵守原来的最多七天规则，工具默认三天；若实际已启用 VPS systemd 自动续期，手动发布前先暂停 timer 并等待正在运行的服务结束，完成后更新自动续期登记再恢复。stable 尚未启用自动续期。

## 备份与边界

VPS 最高权限失守时，发布私钥也可能失守。目录权限用于隔离普通网站和服务账号。应另行保存一份加密的离线备份；同一台 VPS 的 `backup/` 不属于灾难恢复备份。本次没有创建或声称已有异地备份。

旧 build 1 仅信任旧公钥，不能自行迁移到新身份，应使用重新打包的引导客户端。六台 Ubuntu 的协议迁移、stable 推广和内容审核仍需各自安排。
