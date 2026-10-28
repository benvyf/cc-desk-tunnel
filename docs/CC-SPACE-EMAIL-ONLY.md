# CC SPACE 邮箱专用登录页（Windows Build 17）

客户端只通过 CC 管理中心的邮箱账号登录。登录页重新排版为品牌、邮箱与密码、登录偏好、登录按钮和单电脑限制说明。保留密码显示切换、记住登录和自动登录；不显示服务地址、永久凭据、证书指纹或手动连接入口。

启动正式安装的客户端时，会删除当前连接配置文件中的旧 `login` 字段并忽略、清除渲染进程的旧 `proxy-url`，不恢复旧 token 自动连接。邮箱加密会话、本机设备编号、主题偏好、草稿、定时任务与工作区数据保留；其他连接配置在其窗口下次启动时迁移。旧登录 IPC 在打包客户端中不再读取或保存凭据。开发模拟页面仅供未打包的开发环境使用。

邮箱登录成功后，服务端地址、证书指纹和短期授权票据由管理中心下发；只有一个授权工作空间时自动连接，多个时由用户选择。客户端的设置与帮助已更新，不再引导正式用户手填连接参数。协议仍为 22，配套 Linux Build 5 无需因页面更新重新打包。

## 安装与配置

1. 在 https://api.ghostapi.org/cc-updates/admin/accounts 的“管理设备 ubuntu-cc”中配置“连接配置”和“登录用户”，创建自己的邮箱账号并分配工作空间。
2. 如 Ubuntu 尚未升级到 Linux Build 5，先按[试点说明](CC-SPACE-EMAIL-LOGIN-PILOT.md)升级。
3. 退出本机所有 CC 窗口，安装 `D:\cc-desk-tunnel\artifacts\cc-space-email-only-build17\CC-Desk-Tunnel-Setup-0.3.7-x64.exe`，重新启动后输入邮箱与密码。
4. 真实邮箱登录验证成功后，再按[单电脑登录说明](CC-SPACE-SINGLE-COMPUTER-LOGIN.md)将 Ubuntu 的 `PROXY_LOGIN_MODE` 切到 `email`。客户端关闭手动入口不等于远端已关闭旧 token 接口。

本次仅更新 Windows 客户端；管理中心沿用已部署版本。本次未替用户安装本机软件、未改公开发布索引、未创建生产邮箱用户或调用真实 Claude/JEV。安装和真实两电脑切换仍需实机验收。

当前布局及包身份见[Build 17 证据](evidence/email-login-layout-build17-2026-10-28.json)。此前登录修复见[Review 记录](CC-SPACE-EMAIL-ONLY-REVIEW.md)；历史包证据保留。
