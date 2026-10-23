# 定制更新服务：正式部署与维护

> 当前凭据管理方式已更新：2026-10-23 按用户要求重新生成身份并集中保存在 VPS `/root/.cc-update-admin/`，使用 `managed-vps-2026-10-23`。下文旧电脑目录和旧公钥为首次部署历史记录，不再用于新发布；当前路径、指纹和操作见 [VPS 统一发布](VPS-RELEASE-CREDENTIALS.md)。本次仅重启独立更新服务以切换身份，未更改 Nginx 或六台 CC 服务端。

日期：2026-10-23（Asia/Hong_Kong）。独立更新管理服务已部署到现有 VPS，并使用现有 `api.ghostapi.org` 的 HTTPS 证书和站点入口。Windows 客户端接入尚未完成；目前没有已发布安装包。

## 管理员入口和本机身份

管理网页：[https://api.ghostapi.org/cc-updates/admin/](https://api.ghostapi.org/cc-updates/admin/)。这是更新服务独立的管理入口，使用管理令牌登录，与 GhostAPI 登录分开。

管理令牌保存在本机 `C:/Users/benben/.cc-update-admin/access/admin-token.txt`。复制正文到管理页的“管理令牌”字段；退出或刷新后需要重新输入。不要把它填到 CC 客户端、URL 或源码。网页不持久保存令牌，VPS 配置仅保存其 SHA256。

Ed25519 签名私钥保存在本机 `C:/Users/benben/.cc-update-admin/signing/managed-2026-10-23.pem`，对应公钥为同目录 `managed-2026-10-23.pub.pem`。管理令牌与签名私钥是两个独立身份。私钥没有上传 VPS，也没有写入仓库或运行归档。

上述私有根目录在写入凭据前已禁用继承，并仅授予当前 Windows 用户及 SYSTEM 完全控制；子目录和文件继承这组受限权限。后续备份私钥及令牌应使用另一个受保护的管理员备份位置，本次未创建额外私钥副本。

可公开的源地址与可信公钥固定在 [production-public.json](../deploy/update-service/production-public.json)：

- origin：`https://api.ghostapi.org`
- keyId：`managed-2026-10-23`
- 公钥 SPKI DER SHA256：`452a6a71424e9803193783b4c39ddf3f73400ae4b2951564656aa1b31f7ff8bc`

该文件不包含管理员 token、token hash 或签名私钥。后续客户端交付需在打包时固定这些公开参数，不能从网络自动更换可信公钥。

## 已部署内容

| 项目 | 位置或状态 |
| --- | --- |
| 运行源码 | `/opt/cc-update-service`，Linux 验收通过的 `50d8e8e4c294eac7b4a557183ed6a00764119163` |
| 原归档 SHA256 | `4d42accff7fe0830f5322dba70721785b064b21c77ffba08e66d8cead7dcc11a` |
| Node | `/opt/cc-update-runtime/bin/node`，官方 v24.19.0；没有安装系统 npm 依赖 |
| 运行用户 | `ccupdates`，无登录 shell |
| systemd unit | `/etc/systemd/system/cc-update-service.service`，active / enabled |
| 监听 | 仅 `127.0.0.1:8817` |
| 配置 | `/etc/cc-update-service/config.json`，root:ccupdates、0640，父目录 0750 |
| 数据 | `/srv/cc-update-service`，ccupdates 所有；private 0700，public 目录 0755、制品 0644 |
| Nginx snippet | `/etc/nginx/snippets/cc-update-service.conf` |
| 站点变更 | 仅在 GhostAPI 的 HTTPS server 内增加一行 include；原网关路由保留 |

使用已验收的 systemd 模板，并增加 `InaccessiblePaths`：`/opt/sub2api`、`/opt/sub2api-relay`、`/opt/ghostapi-creative-build`、`/etc/nginx`、`/etc/letsencrypt` 和 `/run/docker.sock`。实测该服务 UID 在自身挂载空间不能读取这些路径。

实测 Nginx 的 `www-data` 用户可以读取公开制品，不能修改公开目录或文件，不能读取 private 或服务配置。服务无需 Docker 权限。程序和 Node 归 root 管理，只有独立数据目录供服务写入。

## 当前通道与首次发布

pilot、stable 均为管理员签名的 `state=empty`、revision 1，表示当前没有安装包可用。索引有效期至 `2026-10-25T18:29:20.987Z`，即香港时间 **2026-10-26 02:29:20**。网页沿用 empty 状态的“已撤回发布”文案；这不代表此前发布过真实安装包。

两个签名初始文件保存在本机 `C:/Users/benben/.cc-update-admin/release-output/`，对应输入在 `release-input/`。候选上传与删除已完成，目前候选数、已登记 build 数及公开制品数均为 0。

首次真实安装包可以使用 **build 1**，两个通道各自的下一次 revision 必须 **至少为 2**。不得将旧的 fd6e213 试点包追溯标为 build 1。先完成 Windows 客户端的固定源、可信公钥、下载验签及安装流程，再构建首个引导包。

发布、续期或撤回继续使用 [离线签名工具](UPDATE-SIGNING.md)，私钥留在本机。上传签名文件到管理网页，校验后才能激活。空索引到期不会打断现有 CC 使用，也不会影响管理页登录；下一次发布或维持有效空通道时，需要重新签名更高 revision。

## 已完成的正式验证

- 从当前 Windows 电脑及 VPS 均验证正式公网证书，没有关闭证书校验。管理页与 JS/CSS 返回 200，CSP 等安全头存在。
- 无令牌及错误令牌返回 401，正确令牌可读状态，错误 Origin 返回 403，非法签名候选返回 400，私有路径及目录列表返回 404。
- 两个空通道索引均与本机签名文件逐字节一致，公钥验签通过；HEAD 长度正确，元数据禁止缓存。
- 用短时、非可执行、无任何签名索引引用的 66 字节传输探针，验证实际公开路径 GET/HEAD、206 Range、416 超界及 POST 拒绝；随后删除该探针目录，公开制品目录恢复为空。没有发布测试安装包或占用 build 身份。
- 真实 Edge 浏览器在正式域名上完成登录、查看双通道和退出；无证书例外、无页面脚本错误、无 localStorage/sessionStorage 内容，手机宽度无横向溢出。
- 停止独立服务后保存一致初始数据备份，再启动；签名通道字节保持一致，服务仍 active/enabled。未重启 VPS，开机启动配置已启用但实际重启后的启动尚未演练。
- 现有 7 个容器的 ID、启动时间、运行及健康状态均未变化；Nginx master PID 不变，仅平滑 reload。除 `127.0.0.1:8817` 外没有新增监听，原两个站点的公网及网关健康均为 200/ok。
- 相关服务日志及更新路径的 Nginx 日志检查未发现管理令牌、Authorization/Bearer 凭据、私钥或请求正文泄漏。

完整脱敏证据在本地忽略目录 `.local/update-service-production-evidence/`；包括启动隔离、路由、前后环境、公网/API、传输和浏览器结果。部署临时目录已删除。

## 备份与回滚

本次 root-only 备份目录为 `/var/backups/cc-update-service/deployment-20261022T182951Z`（目录名用 UTC）：原站点配置、部署前快照、部署配置/unit/snippet、BUILD-INFO、停止服务后的一致初始数据和部署验证结果。它不包含本机签名私钥或管理令牌正文。

当前站点 SHA256：`a6da641438efcd93078b56aa792d640e209fd2022a71eb82c33ade965340da35`；原站点 SHA256：`5f6bce1da2ba123f5da9ed2d67e246c7efd20be37d2cb37483b0401b67683d33`。已经验证移除本次 include 后与原站点逐字节一致；没有执行线上撤销再恢复的演练。

如需撤销路由，在 VPS root 运维终端执行以下有 hash 保护的步骤。若后来有人修改过站点文件，断言会停止，应合并其变更，不能直接覆盖：

```sh
python3 - <<'PY'
from pathlib import Path
import hashlib, os, subprocess
site = Path('/etc/nginx/sites-available/ghostapi')
backup = Path('/var/backups/cc-update-service/deployment-20261022T182951Z')
assert hashlib.sha256(site.read_bytes()).hexdigest() == 'a6da641438efcd93078b56aa792d640e209fd2022a71eb82c33ade965340da35'
original = (backup / 'ghostapi.nginx.original').read_bytes()
assert hashlib.sha256(original).hexdigest() == '5f6bce1da2ba123f5da9ed2d67e246c7efd20be37d2cb37483b0401b67683d33'
temporary = site.with_name('.ghostapi.cc-update-rollback.new')
with temporary.open('xb') as output:
    output.write(original)
    output.flush()
    os.fsync(output.fileno())
temporary.chmod(site.stat().st_mode & 0o777)
os.replace(temporary, site)
subprocess.run(['nginx', '-t'], check=True)
subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
subprocess.run(['systemctl', 'disable', '--now', 'cc-update-service'], check=True)
PY
```

回滚只撤销更新服务入口并停用独立服务，保留配置、数据、签名历史和备份；不删除账号或其他软件。数据恢复必须停止服务并整体恢复，保留 channel revision、build 身份和审计对应关系，不可只回滚单条索引。后续有真实发布后，应使用新的整体一致备份，不能再用本次空通道初始数据覆盖发布历史。

内容审核、GhostAPI 统一登录、六台 Ubuntu 服务端迁移以及 Windows 客户端自动升级均不属于本次已部署内容。
