# Windows Build 41：0.3.12 客户端（只发布到 stable）

2026-11-20（香港时间），按用户授权从 `release/client41`（提交 `3d82fe527866a76448bebd118f6520eb6d3a60c2`）生成并发布。**0.3.12 / Build 41 / 协议 25，内嵌通道 stable。** 替换 stable 上的 0.3.11 / Build 40；pilot 保持过渡版 Build 38。

[下载 Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/41/win32-x64/CC-Space-Setup-0.3.12-x64.exe)。大小 **258927142 字节**，SHA256：

```text
f9b3b4dfc643e55b068ed8d7c2054783acddeb468365a13383b3eb2df245a167
```

## 兼容

只发布客户端，协议不变（25），可直接连接已部署的协议 25 服务端（Build 30、31），不需要升级服务端。版本历史登记为 0.3.12 / 协议 25 / Windows 41 / 服务端 Build 31。

用量数据长期保存（活跃度日历显示一整年）和登录授权按节点批量续期，需要先更新管理中心，再发布服务端 Build 32 才生效。旧服务端上调用日志照常显示最近 35 天。

客户端的授权自动续取对新旧服务端都兼容：工作空间以"授权已结束"断开时，客户端会重新取票并重连。

## 本次变化

详见 CHANGELOG 0.3.12：

- 侧栏铃铛左边新增"查看活动"（Ctrl+Alt+U）。
- 已发送的问题可以原地修改。
- 输入框里的图片可以点开看大图。
- "调用日志"页面重新设计，不再逐条列出每次调用。
- 断线后第一分钟内最多每 3 秒重试一次。
- 连接失败的提示不再显示服务器地址。
- 邮箱登录授权被断开时自动重新取得授权。

源码为 main `37f6336c`，主要功能都经过 Fable 设计或审查。发布提交只改版本号、Build、版本历史和变更记录。

## 构建与验收

- 依赖与 Build 40 相同，沿用 `D:/cc-desk-tunnel-release36` 中已安装的依赖；便携 Node 24.22.2、Electron 44.10.1。
- 打包内建检查 3/3 通过。
- 包内身份：Build 41 / 0.3.12 / 协议 25 / stable，源码提交与发布提交一致，固定公钥与更新源不变。新功能文字（查看活动、优先事项、新的重连提示）已在包内。
- 隔离的真实 EXE 验收 `scripts/verify-managed-client.mjs`（短路径 `subst R:`）通过，耗时约 5 分钟。验收项：
  - 旧 IPC 拒绝，新 IPC 参数拒绝；
  - 多 profile 共享缓存，崩溃的忙碌窗口阻止安装；
  - 签名撤回阻止安装缓存的安装包；
  - 真实 NSIS 1→2 更新，以及外部助手确认；
  - 确认后登录页不显示待确认的安装。
- 合入 main 前，各功能分支跑过相关单元测试和界面测试。基线失败（如 `settings.spec.ts:174` 多出"连接"分类）与本次无关。

## 发布与验证

- **上传**：上传后，VPS 上安装包的 SHA256 与本地一致。source bundle 克隆为 `/root/.cc-update-admin/source-build-41`，HEAD 为 `3d82fe5`，工作区干净。
- **准备**：发布前备份配置，并记录 pilot 公开索引的摘要；随后停止两个续期 timer。
- **发布到 stable**：`scripts/publish-managed-update.mjs` 发布为 revision 10。差分 sidecar 已生成；公开索引一致，pilot 不变，公网下载的大小与 SHA256 一致。
- **清理候选记录**：发布后确认候选记录（`2b3e2665…`）是本次发布的那条，然后删除。删除前后公开索引字节不变，候选数为 0。
- **续期登记与恢复**：
  - `automation-stable/config.json` 登记 Build 41、`source-build-41` 和公开安装包路径。
  - 强制续期 stable 10→11，有效期至 2026-11-23，`releaseUnchanged`、`pilotUnchanged`、`publicArtifactVerified` 均为真。
  - 两个 timer 恢复为 active，普通运行均为 not-due（stable revision 11；pilot revision 68 不变）。
  - pilot 公开索引的摘要与发布前一致。
- **保留**：Build 40 的公开安装包保留。
- **记录位置**：
  - 发布前配置备份：`/var/backups/cc-update-service/client41-publication-20261120T094831Z`
  - 受保护发布记录：`/root/.cc-update-admin/release-build41/`
