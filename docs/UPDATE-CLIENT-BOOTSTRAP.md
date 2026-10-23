# Windows build 1 引导安装包构建记录

> 本记录的 build 1 未发布。用户随后授权更换生产身份，凭据已集中保存在 VPS，客户端从 build 2 起固定新公钥。新方案见 [VPS 统一发布](VPS-RELEASE-CREDENTIALS.md)，不再等待旧电脑凭据。

日期：2026-10-23，Asia/Hong_Kong。安装包已本机构建并核对，尚未生成生产签名索引或上传更新通道。

## 制品身份

| 字段 | 值 |
| --- | --- |
| 源码仓库 | https://github.com/benvyf/cc-desk-tunnel.git |
| 源码分支 | `codex/vps-update-channel` |
| sourceCommit | `640588de87f73acffbec2e3e50b8d757412f24a6` |
| 应用版本 / build | `0.3.6` / `1` |
| 协议 / 平台 | `20` / Windows x64 |
| 客户端固定通道 | `pilot` |
| 固定更新源 | `https://api.ghostapi.org` |
| 固定公钥 ID | `managed-2026-10-23`，与 `deploy/update-service/production-public.json` 一致 |
| Windows 代码签名 | 未签名（Authenticode `NotSigned`）；与更新索引的 Ed25519 签名分别处理 |
| 文件名 | `CC-Desk-Tunnel-Setup-0.3.6-x64.exe` |
| 大小 | `201074854` 字节 |
| SHA256 | `845e3e677febbf8a2d0cf63c2e318a27bbe78ffcbdf2fcb71572ce89e75dc171` |

制品保存在 `artifacts/managed-build-1-640588d/`，同目录有 `build-evidence.json`、`SHA256SUMS.txt`、`build.log`、`runtime-state.json` 和 `bootstrap-about.png`。这些本机构建产物被 Git 忽略，跨电脑继续时需另行复制。后续文档提交不改变此安装包的源码身份。

## 构建与核对

- 从以上已提交并推送的源码，在独立、干净的 Git worktree 使用 Node 24 执行 `scripts/package-windows.mjs`，正式构建的清洁检查通过。原工作目录的旧客户端和未跟踪手册保留。
- 使用 `prepare-windows.ps1 -IncludePowerShell` 下载并校验固定官方归档：OpenSSH `10.0.0.0p2-Preview` 与 PowerShell `7.6.6`。未修改系统 sshd 服务或注册表配置。
- 生成真实 NSIS 安装包，打包脚本退出码为 0；其要求的实际打包 Electron 启动测试 `package.spec.ts` 为 1/1 通过，使用隔离 profile，未连接服务端或模型。
- 读取实际 `app.asar`，核对完整提交、build、协议、版本、通道、平台及生产公钥。包内安装助手与源码相同，保持交互安装；归档未包含测试 fixture、源码仓库或本机凭据文件。
- 补充启动同次构建的打包目录程序：更新状态为 idle、内嵌 build 为 1、没有 pending；登录前设置页显示“定制构建 1 · pilot · 协议 20”。使用 `--smoke-test` 禁用自动查询，未向生产更新源发送检查请求。此检查用于核对正式包身份，实际安装、交互取消与重试的证据见 [C 实施计划](superpowers/plans/2026-10-23-update-client.md)。
- 将 EXE 复制到上述制品目录后再次核对完整 SHA256，一致。

## 后续发布

管理员按 [签名说明](UPDATE-SIGNING.md) 核对线上最新 revision，使用既有生产密钥为此制品生成更高 revision 的 pilot 索引，再上传及激活。当前未生成生产签名索引、未上传安装包、未改变 VPS 或六台 Ubuntu。

2026-10-23 10:48（香港时间）发布前核对：线上 pilot 与 stable 均仍为 revision 1、`empty`，两个索引均通过仓库固定生产公钥的签名及有效期验证；有效期至 2026-10-26 02:29（香港时间）。本机制品的大小与完整 SHA256 再次核对一致。脱敏证据及待签名输入保存在 `.local/pilot-build-1-release/2026-10-23T02-48-11-786Z/`。输入中的 revision 2 仅为准备值，实际签名前仍须读取管理状态并刷新时间，公开空索引不能证明 build 未被候选占用。

当前发布受阻：交接记录中的旧电脑 `C:/Users/benben/.cc-update-admin` 和当前电脑对应的 `C:/Users/99794/.cc-update-admin` 均不存在，尚未取得既有生产签名私钥及管理令牌。需要管理员定位或保护迁移原有凭据；不得重新生成身份来代替。此次仅完成只读核对及本地准备，没有创建线上候选、上传或激活。

六台线上服务仍为协议 19，此包为协议 20；首次使用需管理员安排客户端与服务端的配套引导和独立试点，保留旧客户端连接其他节点。
