# CC SPACE 邮箱登录试点

管理中心已部署，ubuntu-cc 的地址与证书指纹已配置。Linux Build 5 已发布到 pilot，Windows Build 11 完整包在本地；尚未替用户执行 Ubuntu 升级或创建邮箱账号。此功能先供本人使用，现有工作区和历史会话继续共用。

## 1. 升级 Ubuntu

先结束 Claude 任务，并退出所有连接该 Ubuntu 的 CC 客户端。将 `scripts/upgrade-cc-space-email.py` 复制到 Ubuntu 家目录，执行：

```sh
sudo python3 ~/upgrade-cc-space-email.py
```

脚本固定 Linux Build 5 / protocol 22 / 归档 SHA256，先校验下载的升级工具，再调用现有受管升级 API。存在活动连接/任务会拒绝安装，依赖/运行环境不兼容也会拒绝；准备、就绪检测及失败恢复由现有监督程序处理。保留现有 Build 4 镜像与冷备份，不重跑 bootstrap，不从旧宿主源码重建 Docker 镜像。

成功显示 `SUCCESS: Linux Build 5 / protocol 22 is installed and committed.`。升级后需要协议 22 的 Windows Build 11，旧 Build 10 客户端不再匹配。若提示失败或等待超时，保存终端结果并先核对状态，不连续重跑。

## 2. 设置自己的登录账号

打开 <https://api.ghostapi.org/cc-updates/admin/accounts>，使用原管理员登录。

在账号监控的节点摘要点击“管理设备 ubuntu-cc”，选择“登录用户”页签，新增自己的邮箱和 8–128 位密码，保持启用并勾选 ubuntu-cc。邮箱只是 CC 登录账号标识，无需与 Claude 账号邮箱相同；密码在页面内设置，不发送到聊天。

“连接配置”已填写 `wss://74.82.201.214:8443/ws` 和完整 SHA256 证书指纹。邮箱登录使用短期票据，不需要把旧永久服务凭据复制给客户端。“高级”里的旧凭据字段可保持空白。

## 3. 安装本机客户端

安装 `D:\cc-desk-tunnel\artifacts\cc-space-email-login\CC-Desk-Tunnel-Setup-0.3.7-x64.exe`（Windows Build 11），在登录页输入刚创建的邮箱/密码。若自动进入旧手动连接方式，切换“使用邮箱登录”。一台授权设备会直接连接；多台时选择设备。

“记住登录”将会话用 Windows 系统凭据加密保存，最长 30 天；不记住时会话仅保存在进程内，最长 8 小时。密码不会写入本地配置。

首轮确认登录、历史会话、退出与重新登录，以及管理中心停用账号后连接会在下次续验关闭。不要为验证主动创建 Claude/审核供应商请求；正常使用时再反馈会话功能。

## 发布与回退记录

- 功能/安装包源码：`12b2da3ca49ffeb7d712a96d4c8302a582a2a873`；后续文档和测试修正不改变包身份。
- 管理中心冷备份：`/var/backups/cc-update-service/email-login-20261028T021053Z`；前一运行目录 `/opt/cc-update-service.before-email-login-20261028T021053Z`。
- Linux 发布与续期配置备份：`/var/backups/cc-update-service/email-server5-20261028T021353Z`；已登记 Build 5 并强制续签/验证 systemd 续期成功。
- Windows 公开更新仍为 Build 9，稳定通道未改；本机安装 Build 11 完整包进行试点。
- 旧 Ubuntu Build 4 冷备份：`/var/lib/cc-space-037-upgrade/backup-20261028T012932Z-31010676`，保留。不要在有新业务数据时直接恢复冷备份；程序升级异常先检查受管升级日志/状态。
- 传统服务 token 入口暂保留 `both` 模式；停用邮箱用户只撤销邮箱授权，不撤销独立的传统 token。邮箱实机验收后再决定是否关闭传统入口。

完整脱敏验证记录：[email-login-2026-10-28.json](evidence/email-login-2026-10-28.json)。
