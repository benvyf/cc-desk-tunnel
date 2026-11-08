# CC Space 0.3.10 / Build 28

本次 Windows x64 客户端使用协议 24，配套已经发布的 Linux Build 12。包含主分支最新 SSH 远程开发、连接恢复、并发和取消、混合剪贴板修复，以及浅色中性主题。

## 保留现有安装与更新行为

当前主分支尚未完整包含已发布 Build 27 的桌面改动。本次从原提交 `0014b68`、`aa25ab4`、`35c2964`、`98d6f43`、`5d4440c` 取回客户端升级提示、CC Space 命名、管理入口限制、安装完成后启动和可恢复安装包清理，保留主分支后续 SSH 生命周期和主题修改。未将整个宿主机或管理中心分支合入此次客户端包。

保留 `io.github.ccdesktunnel.desktop` 安装身份、旧配置目录、更新账本和签名信任。安装包名称为 `CC-Space-Setup-0.3.10-x64.exe`，解析签名时仍兼容不可变的旧名称历史。使用干净提交、固定依赖和 Electron 44.10.1 构建，打包脚本会隔离启动实际程序并检查主进程、preload 与组件回收。

## 升级要求

Build 27 使用协议 23，本次使用协议 24，不能通过放宽协议校验强行自动安装。先下载完整安装包，结束任务并退出所有 CC Space 窗口，保留原安装范围和目录覆盖安装；账号配置和聊天记录沿用原位置。Ubuntu 同时须升级到 Linux Build 12，三台节点仍由用户从管理中心逐台确认。

本次只替换 Windows pilot 下载及其精确自动续期登记，stable 和 Linux 已发布索引保持原字节；不代替用户安装本机程序或升级 Ubuntu 节点。生产私钥和管理令牌留在 VPS，不进入安装包或本机源码。

## 已发布

2026-11-05 已替换管理中心的 Windows pilot 下载。初次发布 revision 39，真实 systemd 沙箱强制续期至 revision 40，普通续期检查为 `not-due`；临时强制参数已移除，两个续期 timer 均 active。应用源码固定为干净提交 `643b1f0390824dabc8e6b4c8b9e0f20d9785e0d6`。

[下载 Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/28/win32-x64/CC-Space-Setup-0.3.10-x64.exe)。文件大小 258,580,014 字节，SHA256 `85205fd44c4ab7dd3ca8e660774d9d4c1b601c3b36ead94ffcd874dfba0cca71`。

验证包括完整核心 884 项通过 / 43 条件跳过、相关界面 85 项通过、实际打包程序隔离启动、2 项真实 NSIS 钩子测试、包内 28 个 CommonJS 文件与源码一致、691 个内置组件文件逐一匹配。内置 PowerShell 和 OpenSSH 实际可运行，SSH 管理模块在实际 Electron 包中加载通过，界面无管理后台入口。首轮未发布包因组件目录链接未被复制而被拦截；改用实体目录重新打包，只有上述最终完整包被签名发布。

VPS 已对公开 HTTP 下载进行完整大小和 SHA256 核对；本机使用内嵌公钥独立验签，并以真实公开 HTTPS Range 核对文件首、中、尾字节。受本机网络影响，完整本机传输过慢或超时，未将其计为通过。完整包已在本机和 VPS 核对同一摘要，未将未完成的下载当作完整验收。

Linux Build 12 索引、stable 空通道、管理中心运行代码、三台节点的当前版本和旧安装任务均保持；没有创建节点安装任务或调用真实模型。三台仍运行 Build 10 / 协议 23，需由用户逐台更新到 Build 12，再使用本客户端。

VPS 发布及源码记录：`/root/.cc-update-admin/release-build28/` 和 `/root/.cc-update-admin/source-build-28/`；发布备份：`/var/backups/cc-update-service/client28-publication-20261105T015345Z`。脱敏证据见 [Build 28 发布记录](evidence/windows-build28-production-2026-11-05.json)。
