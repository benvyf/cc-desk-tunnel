# CC Space 0.3.10 / Windows Build 29

2026-11-05。用户授权打包发布客户端更新提示修复，并在发布验证后清理无用的本地旧安装包和打包临时文件。

本次基于已发布 Build 28 对应的主分支，保留 SSH、主题、安装身份、配置目录、签名信任、账本和安装包清理功能。只修复更新控制器：从已验证签名索引保留较新的跨协议发布元数据，供现有 UI 显示配套升级提醒；不放宽跨协议自动下载、安装、签名或防回放限制。客户端继续协议 24，模型和账号出站仍在 Ubuntu。

Build 27 已安装程序中的旧本地逻辑不会被管理中心远程修改，需手动覆盖安装本次新完整包；结束任务并退出全部窗口，保留原安装范围与目录。服务端应配套协议 24。Build 28 协议相同，可按既有流程升级至 Build 29。

41 项受管客户端及签名契约测试、跨协议界面测试通过。增加协议版本检查后整组 48 项核心测试通过，另外 2 项真实 NSIS 钩子测试通过；真实 EXE 隔离启动、28 个主进程模块及 691 个内置组件文件匹配验证通过。签名仅在 VPS 完成。线上仍被索引引用或用于回退的制品保留，不以本地旧包清理为由删线上下载。

## 已发布

2026-11-05 已发布 Windows pilot Build 29，初始 revision 41，强制续期验证后为 revision 42；随后真实 systemd 服务运行成功，两个续期 timer active。干净源码 `25cb477603ae05d3997d0fcf45967affa519df5e`。

[下载 Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/29/win32-x64/CC-Space-Setup-0.3.10-x64.exe)。258,579,717 字节，SHA256 `2feae8b42039bd5a38436b2b52b8bde9335ca2a39803d168a39a3e27b06f5c71`。线上完整下载大小/hash、签名、精确续期登记通过；本机用内嵌公钥独立验签，核对目标 Build 和安装包摘要一致。

Linux 索引（Build 14）、Windows stable 和管理中心运行清单未变，没有重启管理中心或操作 Ubuntu 安装。发布备份 `/var/backups/cc-update-service/client29-publication-20261105T034026Z`；VPS 制品和源码位于 `/root/.cc-update-admin/release-build29/`、`/root/.cc-update-admin/source-build-29/`。详见 [脱敏证据](evidence/windows-build29-production-2026-11-05.json)。

## 旧安装包清理

发布验证后，按事先生成的本地清单删除 `D:\cc-desk-tunnel\artifacts\` 和 `.local\` 下 23 个旧安装包及对应附属文件，共 31 个文件、11,094,310,465 字节（约 10.33 GiB）。删除前核对绝对路径、文件名、大小、路径无重解析点及无对应运行进程；删除后重新核对最新 Build 29 安装包 hash，保持一致。

保留最新安装包、当前展开验证目录、组件源文件、日志、证据、Git 源码及线上下载/回退制品。没有删除用户已安装软件、安装目录、账号、配置或聊天数据。完整删除清单保存在本机 `.local/client29-cleanup-result.json`。
