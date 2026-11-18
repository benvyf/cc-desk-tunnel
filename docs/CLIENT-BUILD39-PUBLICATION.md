# Windows Build 39：协议 25 新客户端（只发布到 stable）

2026-11-18（香港时间），按用户授权从 `release/client39`（提交 `3f16bbfe6863fe42726902cf613f5210238764e5`）生成并发布。**0.3.10 / Build 39 / 协议 25，内嵌通道 stable。** 这是[两通道发布说明](CLIENT-BRIDGE-RELEASE.md)的第 5 步：只发布到 stable，pilot 保持过渡版 Build 38。

[下载 Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/39/win32-x64/CC-Space-Setup-0.3.10-x64.exe)。大小 **258911481 字节**，SHA256：

```text
0603df153914537d6607b2bad1c32bde8e0fa29d07471be3906b4df752f7f448
```

## 发布时机

用户选择在协议 25 服务端（计划 Build 30）构建前先发布。在服务端升级前，已装 Build 38 的客户端检查更新时会看到 Build 39 和“新版客户端需要配套升级服务端”的提示，可手动获取完整包，但不会在应用内自动安装；手动装上 Build 39 的客户端在服务端升级前无法连接协议 24 的工作空间。

## 本次变化

子代理步骤、只读 Git 改动面板、会话分支树、回复模型标注、Ctrl+K 命令面板、批量归档与删除，以及过渡版引入的应用内跨协议更新（[强制规则第二节第 6a 条](UPDATE-RELEASE-RULES.md)）。版本历史在 `deploy/managed-protocol-history.json` 中登记为协议 25 / Windows 39 / 配套服务端 Build 30（尚未构建）。

## 构建与验收

- 基于 `origin/main`（600a911f），依赖与 Build 38 相同，沿用 `D:/cc-desk-tunnel-release36` 的已安装依赖；便携 Node 24.22.2、Electron 44.10.1。
- 打包时发现 Git 改动面板依赖的 `git-bash.mjs` 未进入安装包（打包脚本的加载检查拦下），提交 `3f16bbfe` 将其加入打包清单。打包内建检查 3/3 通过；包内身份 Build 39 / 0.3.10 / 协议 25 / stable，固定公钥与更新源不变。
- 单元测试 1283 项：11 项失败，均为本机环境类（Windows tar 打包 3、SSH/scp 执行通道 6、权限 1、通道静默 1），与本次改动无关。
- 隔离的真实 EXE 验收 `scripts/verify-managed-client.mjs` 通过：旧 IPC 拒绝与新 IPC 参数拒绝、多 profile 共享缓存与崩溃忙碌窗口阻止安装、签名撤回阻止缓存安装包、真实 NSIS 1→2 与外部助手确认、确认后登录页不显示待确认安装。该脚本自 2026-10-31 的 IPC 来源加固后已无法运行（模拟事件缺少 `sender`，界面步骤指向已移除的入口），修复另行提交到 main，不在本发布提交内；验收须在短路径下运行（例如 `subst`），否则内置 Office 组件路径超过 Windows 260 字符上限。

## 发布与验证

- VPS 上传后核对摘要；停两个续期 timer；bundle 克隆为 `/root/.cc-update-admin/source-build-39`。
- 发布到 stable：revision 5，公开索引、公网下载大小与 SHA256、pilot 不变均通过；候选记录确认后删除，公开索引字节不变。
- 续期：`automation-stable/config.json` 登记 Build 39 与 `source-build-39`（续期脚本与签名契约未变）；强制续期 stable 5→6，有效期至 2026-11-21，候选 0，pilot 字节不变；两个 timer 恢复，普通运行均 not-due。pilot 仍为 Build 38（revision 67），登记不变。
- 以更新控制器读取实时签名索引：Build 37（pilot）可下载 Build 38；Build 38 连旧服务端时显示 Build 39 但提示需配套迁移服务端、不可安装；Build 38 在服务端要求协议 25 时可下载 Build 39；Build 39 无更新。
- 发布前配置备份：`/var/backups/cc-update-service/client39-publication-20261118T093950Z`；受保护发布记录：`/root/.cc-update-admin/release-build39/`。

## 后续

1. 构建协议 25 服务端（Build 30），并在各 Ubuntu 节点做镜像升级。
2. 升级后在真实环境走通：Build 38 连接协议 25 服务端时提示并一键更新到 Build 39；管理中心 426、local 直连、稍后更新后重连。
3. 若之后重发过渡版 B′（> 39），必须以更高 build 重发 stable 最新版。
