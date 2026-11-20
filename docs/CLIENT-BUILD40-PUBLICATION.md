# Windows Build 40：0.3.11 客户端（只发布到 stable）

2026-11-20（香港时间），按用户授权从 `release/client40`（提交 `2dd463f9d417d80aabab6659fb55ade8b5ea7b24`）生成并发布。**0.3.11 / Build 40 / 协议 25，内嵌通道 stable。** 替换 stable 上的 0.3.10 / Build 39；pilot 保持过渡版 Build 38。

[下载 Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/40/win32-x64/CC-Space-Setup-0.3.11-x64.exe)。大小 **258915960 字节**，SHA256：

```text
d01b72cdecaeca71b6ed9a35a3f69bca8c74a0b087432f8a2d7de51c792a6a34
```

## 兼容

只发布客户端，协议不变（25）：直接连接已部署的协议 25 服务端（Build 30、31），不需要升级服务端。版本历史登记为 0.3.11 / 协议 25 / Windows 40 / 服务端 Build 31。两个新的权限设置只在服务端发送它们时显示（旧服务端上隐藏）；服务端侧的改进（更新的忙闲判断、更新前结束会话并写明原因、用户消息索引）已在 main，随下一个服务端 Build 生效。客户端只在非托管构建且协议不一致时比较应用版本号，0.3.11 客户端连接 0.3.10 服务端不会出现版本提示。

## 本次变化

见 CHANGELOG 0.3.11：长会话流式输出性能（已完成回答不再重新解析、只重绘变化的轮次、流式回答只重解析最后一段且已完整段落原地保留、查找和本机缓存减少重复工作）、可能误导的链接先确认、两个权限设置。源码为 main `99c0f4cd`（上游 0.3.16 选取与长会话性能两个分支，均经 Fable 多轮审查），发布提交只改版本号、Build、版本历史和变更记录。

## 构建与验收

- 依赖与 Build 39 相同，沿用 `D:/cc-desk-tunnel-release36` 的已安装依赖；便携 Node 24.22.2、Electron 44.10.1。
- 打包内建检查 3/3 通过；包内身份 Build 40 / 0.3.11 / 协议 25 / stable，源码提交与发布提交一致，固定公钥与更新源不变；新功能文字已在包内。
- 发布分支桌面与协议单元测试 837 项：9 项失败，均为基线即有的本机环境类失败。合入 main 前的全量单元测试（1300 项，14 项基线失败）与全量界面测试（924 项，87 项基线失败，无新增）见对应分支记录。
- 隔离的真实 EXE 验收 `scripts/verify-managed-client.mjs`（短路径 `subst R:`）通过：旧 IPC 拒绝与新 IPC 参数拒绝、多 profile 共享缓存与崩溃忙碌窗口阻止安装、签名撤回阻止缓存安装包、真实 NSIS 1→2 与外部助手确认、确认后登录页不显示待确认安装。

## 发布与验证

- VPS 上传后核对摘要；停两个续期 timer；bundle 克隆为 `/root/.cc-update-admin/source-build-40`。
- 发布到 stable：revision 8，公开索引、公网下载大小与 SHA256、pilot 不变均通过；候选记录确认后删除，公开索引字节不变。
- 续期：`automation-stable/config.json` 登记 Build 40 与 `source-build-40`（续期脚本与签名契约未变）；强制续期 stable 8→9，有效期至 2026-11-23，候选 0，pilot 字节不变；两个 timer 恢复，普通运行均 not-due。pilot 仍为 Build 38（revision 68），登记不变。
- 以更新控制器读取实时签名索引：Build 37（pilot）可下载 Build 38；Build 38 连旧服务端时显示 Build 40 但提示需配套迁移服务端、不可安装；Build 38 在服务端要求协议 25 时可下载 Build 40；Build 39 可更新到 Build 40；Build 40 无更新。Build 39 的公开安装包保留。
- 发布前配置备份：`/var/backups/cc-update-service/client40-publication-20261120T012842Z`；受保护发布记录：`/root/.cc-update-admin/release-build40/`。
