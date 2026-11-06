# Windows Build 31：终端窗口诊断

2026-11-06，香港时间。Windows pilot 已发布 CC Space 0.3.10 / Build 31 / 协议 24，源码 `dd8effed83cf8620429dd3d68d16994e4cc3ce53`。服务端配套更新见 [Linux Build 18](RELEASE-SERVER-BUILD18.md)。

Build 31 已签名的原发布说明提到 Linux Build 17；同轮安装准入核验后，17 已被 18 替代。服务端应选择管理中心当前提供的 **18**，不重试 17。原客户端制品及签名身份不原位改写。

记录独立终端窗口的原生关闭请求、应用主动销毁、主窗口关闭、无响应/恢复，以及终端和主页面的渲染进程退出原因。没有证据证明偶发窗口消失或缩放卡顿已完全修复；本版补齐定位信息，不把 03 的服务端镜像异常与所有窗口问题混为同一原因。

[完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/31/win32-x64/CC-Space-Setup-0.3.10-x64.exe)：258,602,450 字节，SHA256 `fa441d69d08e880c5ca892c2b20570f781be0f31ac094068e8495bf63f805511`。已安装客户端可在客户端内检查更新；同协议使用原有验签安装流程，跨协议保留经签名验证的完整包获取入口及配套说明。无需为了安装服务端 Build 18 而降低校验。

真实 EXE 离线启动、28 个主进程模块、691 个内置组件、安装包压缩流及解包后的 app.asar 一致性核验通过。PowerShell 文件相对 Git blob 的 CRLF/LF 差异按文本换行归一后核对。没有在用户日常 profile 安装或启动模型运行时。

窗口控制/缩放/最大化/还原真实 Electron 回归通过；窗口控制相关 9 项 Node 测试通过。用公开已验签索引经过真实控制器验证同协议更高 Build、跨协议提示/获取地址、拒绝跨协议自动下载安装、查看后提示保留和当前 Build 无更新。更新 UI 隔离适配夹具 24/24 通过，包含登录前/断开、下载失败重试、更新后授权和真实签名控制器状态；沿用 Build 30 的 SSH API 夹具适配，不替换产品逻辑。

pilot revision 46；完整公开下载摘要、独立签名与实际安装包身份、精确续期及真实 systemd 验证通过，两个 timer active。续期源固定 `/root/.cc-update-admin/source-build-31`，安装包单独保留在 Build 31 制品路径。签名是受管更新索引签名，未新增 Authenticode 签名。旧包不覆盖，stable 保持。

备份 `/var/backups/cc-update-service/client31-publication-20261106T101452Z`。Windows 发布时 Linux 索引保持；同轮随后发布 Linux Build 18。管理中心运行文件未修改、未重启；没有创建或执行 Ubuntu 安装任务。[发布证据](evidence/windows-build31-production-2026-11-06.json)、[最终双端公开验签](evidence/terminal-build18-client31-public-signatures-2026-11-06.json)。
