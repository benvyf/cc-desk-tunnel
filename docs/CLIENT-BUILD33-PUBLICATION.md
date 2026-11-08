# Windows Build 33：本地历史与经典终端宽度重排

2026-11-08，香港时间。Windows pilot 已发布 CC Space **0.3.10 / Build 33 / 协议 24**，发行源码 `109b255e4eed3ffe68b4fa149e563673c0440ebe`，基于最新功能提交 `7b1c3b1`。管理中心 Windows 下载入口已从 Build 32 切换到 33；旧制品保留，不原位覆盖。

[下载 Windows 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/33/win32-x64/CC-Space-Setup-0.3.10-x64.exe)。大小 **258,618,440 字节**，SHA256：

```text
3e2e59d0b328cbcc55d91da3bd05d13b474f8534feb6bdc532d782bc19786db8
```

包含最新主分支的本地历史缓存、连续记录修复，以及经典布局窗口宽度变化后的手动「按新宽度重排」。用户必须主动点击并确认；确认框说明输入草稿、后台命令及进程内临时状态会丢失。此次宽度重排功能复用现有服务端关闭/打开及 resume 能力，无需为此升级服务端。本包不包含 UI 审查中提出但未实现的禁用态视觉补齐。

## 验证

- Windows x64 使用锁定的 Electron 44.10.1；复用缓存时发现旧版 44.5.1 后停止首轮构建，补齐正确版本重新完整构建，旧轮产物未发布。
- 实际打包 EXE 的隔离 profile 离线启动及随包组件回收 1/1 通过，没有安装到用户日常目录或启动模型。
- NSIS 内嵌压缩流完整性通过；从实际安装包提取的 app.asar 与构建产物逐字节一致。内嵌 Build、协议、源码身份一致；28 个主进程模块、691 个随包组件逐项匹配。7-Zip 对整个 NSIS 提示尾部有附加数据，另行按其报告的偏移/长度提取纯 7z 载荷后，2440 文件无警告完整性检查通过。
- 更新、安装器与窗口核心测试 57 通过、0 失败、2 平台条件跳过；类型检查通过。发行前功能基线终端 UI 158/158、test-main 559 通过/58 既有跳过/0 失败。Build 元数据变更未改功能运行代码。
- 公网签名独立验证通过；VPS 完整公开下载的大小与 SHA256 通过，本机首/中/尾三个 HTTPS Range 与实际安装包字节一致。
- Windows pilot 初次发布 revision 49，强制精确续期后 revision 50，发布时有效期至 2026-11-11T06:13:44.734Z。续期不变更 Build 和制品身份。
- 自动续期登记固定干净源码 `/root/.cc-update-admin/source-build-33` 和公开 Build 33 包。强制续期成功，真实 systemd 常规执行返回 not-due，Windows/Linux 两个续期 timer active。
- Windows stable、Linux pilot 索引、旧 Build 32 完整安装包、管理中心运行 inventory 全部保持。未重启管理中心、未创建生产 Ubuntu 安装任务、未调用模型。

发布备份：`/var/backups/cc-update-service/client33-publication-20261108T061206Z`。VPS 受保护发布日志及证据：`/root/.cc-update-admin/release-build33/`。私钥与管理员令牌未离开 VPS。管理中心刷新后下载新包，或从现有受管客户端检查更新。包没有新增 Authenticode 签名，受管索引沿用既有 Ed25519 信任。

[结构化发布证据](evidence/windows-build33-production-2026-11-08.json)。
