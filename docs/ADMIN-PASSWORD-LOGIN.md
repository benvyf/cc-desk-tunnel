# 管理中心自设密码登录

2026-10-23。用户要求自行设置密码，避免手动复制管理令牌造成登录错误。

## 首次设置与忘记密码

在有 VPS SSH 权限的 Windows 电脑上，运行：

```powershell
ssh -i "$env:USERPROFILE\.ssh\cc-hk-relay-ed25519" -o BatchMode=yes -o StrictHostKeyChecking=yes root@74.82.201.214 cc-admin-password-setup | ForEach-Object { Start-Process -FilePath $_ }
```

命令通过 SSH 在 VPS 生成十分钟有效的一次性设置链接，并直接交给本机浏览器打开；不复制原管理令牌，也不在聊天中传递密码。网页输入两次自选密码（12–128 个字符，支持中文），保存后自动登录。以后直接访问 `https://api.ghostapi.org/cc-updates/admin/`，使用管理员密码登录。

忘记密码时重新运行同一命令。生成新设置链接会使旧链接无效，实际保存新密码后使原有密码会话失效。

VPS 入口 `/usr/local/sbin/cc-admin-password-setup` 调用 `/opt/cc-update-runtime/bin/node` 及 `/opt/cc-update-service/scripts/create-admin-password-setup.mjs --config /etc/cc-update-service/config.json`。该 CLI 仅允许 root 运行，没有公开的设置链接生成接口。链接的设置凭据放在 URL fragment 中，页面读取后立即清除地址栏 fragment，不进入 HTTP 请求路径或 Nginx access log。

## 凭据与会话

- 密码通过 scrypt（N=16384、r=8、p=1）加随机盐派生，服务私有目录 `private/admin-login.json` 仅保存盐和哈希，不保存明文。
- 设置凭据同样仅保存 SHA-256 摘要及有效期。保存密码与消费一次性设置凭据通过同一个原子文件替换提交。
- 文件权限 0600，归属与既有 private 目录一致，使 root 创建的设置凭据可由 ccupdates 服务读取。目录沿用 0700。
- 登录返回随机临时 Bearer 会话，保存在浏览器内存中；服务端仅在内存保存摘要，八小时过期，退出可撤销。页面刷新后需要再次登录，服务重启也会使现有密码会话失效。
- 密码登录、设置及退出均检查 Origin；登录/设置限 JSON 请求和 2 KiB 请求体，失败次数采用既有每分钟 30 次限制。服务一次只执行一个密码派生，避免大量并发占满 VPS 内存。
- 原管理员令牌继续支持已存在的发布和自动续期。密码仅用于网页登录，不替换签名私钥或发布自动化凭据。
- 原令牌登录移到折叠选项，增加字符格式检查；中文误粘贴不会再进入 Authorization 请求头，避免浏览器抛 ISO-8859-1 错误。

## 验证与部署边界

本次相关测试共 12 项通过，包含一次性设置/重设、中文密码、错误密码、会话过期/退出、请求来源、限流、原令牌兼容，以及真实浏览器设置与登录流程。TypeScript 检查、代码格式及 diff 检查通过。

本地完整源码已经包含尚未部署的审核配置模块。为仅修复当前线上登录，本次以线上基线构建独立的密码补丁，只增加认证模块、密码页面及 SSH 设置命令；不发布 JEV 模块，不切换更新通道或 CC 节点。独立补丁也经过隔离 HTTP 验收，确保不依赖未上线的审核模块。

上线前备份所有修改文件和 BUILD-INFO，检查前置文件 SHA-256；重启管理服务后检查旧管理员令牌认证、发布状态一致、密码页面及 CLI 文件权限。用户密码由用户最后亲自在网页设置，开发验收不替用户设定生产密码。

密码补丁已上线，源提交 `9a98ca2`，回滚文件和结果位于 VPS `/root/.cc-update-admin/maintenance/password-9a98ca2/`，共变更 7 个运行文件。公网旧令牌认证返回 200，发布状态与补丁前一致；SSH 设置命令生成的链接格式、凭据文件归属和 0600 权限验证通过。公网真实浏览器验证密码页面、设置页、清除 URL fragment、拒绝无效链接及尚未设置密码的提示。生产密码仍等待用户亲自在网页设置。
