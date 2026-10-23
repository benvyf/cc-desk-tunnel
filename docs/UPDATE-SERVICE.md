# VPS 定制更新管理服务

本文保留更新服务初次部署流程。2026-10-23 的监控上线准备已核对线上运行归档 `2638731374c87e767eca6ff1ec37b6a7352ab4d1`，其中包含内容审核和管理员密码登录；合并监控时完整保留这些模块与生产数据。后续实际部署结果见 [账号监控部署记录](ACCOUNT-MONITOR-DEPLOYMENT.md)。

这是 [更新通道总设计](superpowers/specs/2026-10-23-vps-update-channel-design.md) 的交付 B，实现独立管理网页、签名候选上传、发布/撤回、审计与只读通道索引。它复用 [签名工具](UPDATE-SIGNING.md)，分发服务不保管签名私钥。

源码交付后已完成[真实 Linux 隔离验收](UPDATE-SERVICE-LINUX-ACCEPTANCE.md)，随后完成[初次正式部署及公网验证](UPDATE-SERVICE-PRODUCTION.md)。管理页位于 `https://api.ghostapi.org/cc-updates/admin/`。该初次部署记录中的空通道和客户端进度是历史状态，当前发布以管理接口实际数据为准；监控部署不修改签名通道、安装包、审核策略或管理员密码。

## 运行结构

- Node **24**，使用内置 SQLite、HTTP、crypto，无 npm 运行依赖。
- 程序：`/opt/cc-update-service`，Node：`/opt/cc-update-runtime/bin/node`，均由 root 管理、服务用户只读。
- 配置：`/etc/cc-update-service/config.json`，独立管理员身份与固定可信公钥。
- 数据：`/srv/cc-update-service`，专用用户 `ccupdates` 可写。
- `private/`：0700，包含 state.sqlite/WAL、owner.sqlite 和未公开候选。
- `public/artifacts/`：目录 0755，安装包 0644；Nginx 用户只可读，不能写入。不要给 Nginx 读取 private/ 的权限，也不要将整个数据目录映射为站点根目录。
- Node 仅监听 `127.0.0.1:8817`。Nginx 负责外部 HTTPS、静态安装包 GET/HEAD 与单段 Range。通道索引由 Node 从 SQLite 当前活动行返回，事务提交时原子切换，只有这一份索引状态。

数据目录必须位于同一个本机文件系统，候选与公开制品的排他硬链接不支持跨磁盘分挂载。不要使用不支持 SQLite 锁/可靠同步的网络共享。根数据目录应由管理员预先创建。首版不自动删除历史发布制品；未用候选可在网页移除，最多保留 8 个。

## 管理员身份和配置

网页入口 `/cc-updates/admin/`。使用本服务独立的随机管理员令牌，不使用 CC 或 GhostAPI 凭据。令牌至少 32 字符、最多 128 字符，仅接受字母、数字、`-`、`_`。推荐在管理员电脑的受保护目录生成 32 随机字节的 Base64URL 令牌，正文留在管理员电脑，VPS 只保存 SHA256。以下命令会新建文件，不覆盖现有文件；不要在源码或发布输出目录运行：

```powershell
node --input-type=module -e "import {randomBytes,createHash} from 'node:crypto'; import {writeFileSync} from 'node:fs'; const token=randomBytes(32).toString('base64url'); writeFileSync('admin-token.txt',token,{flag:'wx',mode:0o600}); writeFileSync('admin-token-sha256.txt',createHash('sha256').update(token).digest('hex'),{flag:'wx',mode:0o600});"
```

Windows 下用受保护目录的访问权限保存令牌；文件的 POSIX mode 不代替 Windows ACL。本轮测试没有运行上述生产凭据生成步骤。

从 `deploy/update-service/config.example.json` 复制配置到独立配置目录，替换所有占位值：

| 字段 | 内容 |
| --- | --- |
| origin | 管理页实际 HTTPS origin，例如 `https://updates.your-domain.tld`，不带路径、尾斜杠、用户名或密码 |
| dataDir | 数据根的绝对路径，使用上文专用目录 |
| port | 预检确认空闲的高位端口，与 Nginx 配套，示例 8817 |
| adminName | 审计中的管理员名称，1–64 位字母数字或 `_.-` |
| adminTokenSha256 | 管理员随机令牌的 64 位小写十六进制 SHA256 |
| trustedKeys | keyId → Ed25519 SPKI 公钥 PEM，JSON 中换行用 `\n`；必须与离线签名者及未来客户端一致 |

样例故意不可直接启动，避免占位配置被误当成生产密钥。拒绝未知字段、非 HTTPS origin 和私钥 PEM。公钥可以公开，但不能用网络返回内容自动替换。更换管理员令牌时修改 hash 并重启服务；旧令牌随即失效，签名公钥不受影响。

令牌只保存在网页当前内存，刷新或退出后重新登录；没有 cookie、持久 session、localStorage 或 URL 令牌。API 每次验证 Bearer hash，修改操作还要求精确 Origin。登录失败有服务级限速，不阻断有效令牌；公开前可按实际反向代理来源配置 Nginx 来源限速。页面 CSP 禁止内联执行和嵌入，notes 按纯文本显示。

## 管理操作

1. 管理员电脑构建安装包，并用离线签名工具生成 signed index；私钥不上传。
2. 网页登录，选择“签名索引（JSON）”并添加候选。索引上限 64 KiB；先验签与有效期，再进入私有候选区。
3. 如需新制品，为候选选择精确同名 EXE 并上传。文件不得超过签名 size 或 1 GiB，最长 10 分钟。服务流式校验 size/SHA256，任何错误、中断或超量都不会进入公开目录。
4. 点击“发布到通道”。服务重新验签、重新读取制品校验、确认 revision/build 规则，然后切换活动索引并写入审计。
5. pilot 验证后，为同一制品签署 stable 索引，使用 stable 自己的 revision；已登记且身份一致的制品无需重传。每 3 天续期时，同 build、新 revision、新有效期即可。
6. 撤回使用更高 revision 的 `state=empty, release=null` 签名索引。网页显示“确认撤回”，不会自行签署撤回。保留历史安装包，不逆转已完成的安装。

同 revision/同原始载荷激活是幂等重试；同 revision 不同载荷、revision 降低均拒绝。新 build 必须高于跨通道已保留的最大 build；同 build 的版本、协议、源码提交、文件名、size/hash 不可改变。同通道不允许回退到曾发布的更低 build，撤回也不重置此下限。stable 首次推广可以复用 pilot 的已知制品。回滚需要旧源码重新构建并使用新 build。

普通 CC 客户端没有管理权限。本服务只发布 Windows 客户端更新，不安装、控制或重启六台 CC 服务端。

## 归档和 Linux 部署模板

在清洁、已提交的源码根目录使用 Node 24 打包：

```powershell
node scripts/package-update-service.mjs artifacts/cc-update-service.tar.gz
```

输出必须不存在。归档只含明确列出的运行源文件、网页、共享验签模块、部署模板及本文；内置独立 type=module 清单及 BUILD-INFO.json，记录源码提交、Node 版本和文件 hash。不包含 node_modules、实际配置、密钥、GhostAPI 或 CC 会话数据。不需要 `npm install`。检查归档：

```text
tar -tzf artifacts/cc-update-service.tar.gz
```

部署前先核对实际 VPS 的域名/TLS、现有路由、空闲端口、现有服务和数据路径、公钥与管理员 token hash，保存配置备份。模板不能直接覆盖现有 Nginx 主配置。

测试 Linux 准备专用身份及目录示例（安装 Node 24 到上述独立 runtime 路径，来源/校验按管理员现有方法）：

```sh
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin ccupdates
sudo install -d -m 0755 /opt/cc-update-service /etc/cc-update-service
sudo install -d -m 0755 -o ccupdates -g ccupdates /srv/cc-update-service
sudo tar -xzf cc-update-service.tar.gz -C /opt/cc-update-service
sudo chown -R root:root /opt/cc-update-service
sudo install -m 0640 -o root -g ccupdates prepared-config.json /etc/cc-update-service/config.json
sudo install -m 0644 /opt/cc-update-service/deploy/update-service/cc-update-service.service /etc/systemd/system/cc-update-service.service
sudo systemctl daemon-reload
sudo systemctl start cc-update-service
```

systemd 模板使用专用用户、只读系统、仅数据目录可写、无额外 capability。需按实际旧服务路径补 `InaccessiblePaths` 或其他宿主隔离，并核对现有凭据目录不是世界可读；不要让该服务读取旧 GhostAPI/CC 配置或数据。它不挂载 Docker socket，也不需要 CC 容器或宿主控制权限。

将 `deploy/update-service/nginx.conf.example` 的 location 合入目标 HTTPS server，保留原站点配置。公共制品 location 使用精确匹配、只读 alias、禁止符号链接和目录浏览；仅匹配安装包，数据库及候选不会被分发。再运行 `nginx -t`，成功后才 reload。常见部署故障：origin 与网页域名不一致返回 403；dataRoot 缺少 Nginx 穿越权限导致下载 403；Node 端口与代理不一致导致 502。

## Linux 验收与恢复

上线前在测试 Linux 实际完成：

- `systemctl status cc-update-service`、`ss -lntp` 确认仅回环监听；非授权管理请求为 401，错误 Origin 为 403。
- 使用临时测试签名身份和 fixture 测试上传、发布、续期、推广、撤回，确认公开索引字节与原签名文件完全一致；不要把临时签名公钥混进生产可信表。
- HTTPS 安装包完整 GET 的 hash/size 正确，HEAD 长度正确；`Range: bytes=0-15` 返回 206、正确 Content-Range 和前 16 字节；超界 Range 返回 416。
- 任意 private、数据库、候选、目录列表 URL 返回 404/拒绝。修改请求没有正确令牌及 Origin 时不写入磁盘；日志不包含 Authorization、token、私钥或请求正文。
- 上传中断、激活失败、服务重启后旧索引仍完整；同数据目录第二个进程启动失败。核对硬链接和 Linux 文件/祖先目录 sync 行为及权限。

发布顺序：持久保留 build 身份 → 排他放入已校验完整制品 → 同步文件及祖先目录 → SQLite 事务切换 channel 和记录发布审计。失败不会覆盖已有制品。若留下 reserved build，可用相同制品身份和有效签名重新上传/激活；不能把这个 build 改给另一份安装包。不要手工清除 build 或发布审计记录来绕过下限。

进程锁由单独 SQLite 排他事务持有，进程退出后 OS 自动释放，不需要删除“过期锁文件”。启动移除未完成 .part 和无效私有上传状态。历史已发布文件不自动清除。磁盘损坏或已发布文件 hash 不符时停止继续激活，从可信备份恢复或重新构建更高 build。

备份时先停止此独立服务，对完整数据目录（包括 SQLite 文件/WAL、候选和公开制品）及外部配置做一致备份，再启动服务。恢复必须整体对应，不能只回滚数据库或单条通道记录，否则会破坏 build/revision 历史。签名私钥始终在管理员电脑独立备份。

## 本地验证

```powershell
node --test apps/update-service/test/*.test.ts apps/desktop/test-main/package-update-service.test.mjs
$env:CC_UPDATE_UI_TEST='1'
node --test apps/update-service/test/ui.test.ts
Remove-Item Env:CC_UPDATE_UI_TEST
npm run typecheck
npm test
npm run build
npm run format:check
```

浏览器测试默认不进入普通 Node 套件；显式启用后使用隔离浏览器、临时 Ed25519 签名身份和已有公开 TLS fixture，验证真实 HTTPS origin 下的网页操作。Windows 默认使用已安装 Edge；其他平台可安装 Playwright Chromium 或设置 PLAYWRIGHT_CHANNEL。测试 TLS 信任例外仅在测试浏览器 context，不修改生产程序。
