# C：Windows 定制客户端更新实施计划

日期：2026-10-23。依据 [总设计](../specs/2026-10-23-vps-update-channel-design.md)。

## 范围与交付顺序

1. 固定打包身份：独立公开配置、正整数 build、源码提交、协议、版本、公钥及 HTTPS origin。发行构建要求清洁 Git 源码；开发和非 Windows 构建保持禁用安装。
2. 主进程控制器复用既有签名契约。安装身份由真实 EXE 目录规范化计算；状态、进程注册和操作锁共享于 LOCALAPPDATA。状态原子保存；查询与下载持有同一进程锁，进程崩溃后按 PID 回收。
3. Chromium 网络下载：固定路径、元数据不跳转、制品仅同源固定前缀、响应大小限制、严格 Range、时间上限和取消。安装前重新读取签名索引并校验完整文件。
4. 新语义 IPC 与关于更新界面不依赖服务端连接；旧三项 IPC 继续拒绝。运行中的所有安装实例登记并报告活动，状态过期或未知时拒绝安装。
5. 安装前所有窗口必须先断开远端连接，结束任务、原生终端及登录流程。先冻结新连接，再协调实例退出；外置安装助手等待进程退出后按固定参数运行已校验 EXE，不杀任务。pending 仅在新内嵌 build 启动后确认，失败保留诊断。
6. 使用临时密钥验证控制器、网络、共享锁、撤回、篡改、IPC、pending 和打包配置；运行类型检查、构建和适用现有回归测试。另做真实打包 Electron 测试。
7. 独立 Windows 环境实际 build 1 → build 2 安装、取消和失败验收后才能签名发布。不得覆盖当前用户已安装客户端，不用解包启动冒充安装验收。

## 验证边界

本阶段不部署 VPS、不初始化密钥或数据库、不升级六台 Ubuntu、不调用 Claude/JEV、不发布 pilot/stable。生产 build 1 必须来自最终清洁提交；开发验证制品不作为生产发布包。

## 进度

- [x] 阅读设计和既有接入代码，确认本机 Node 24 运行时。
- [x] 固定身份和打包接入。
- [x] 控制器、网络与共享状态。
- [x] IPC、界面与退出协调。
- [x] 自动化与真实 Electron 验证。
- [x] 独立测试产品的真实 NSIS build 1 → 2 安装、目标启动确认与篡改失败验证。
- [x] 隔离测试产品的原生交互安装取消、旧版恢复与重新安装验收。
- [x] 提交并推送源码，从清洁提交构建正式 build 1 引导包并核对。
- [x] 管理员生成生产签名索引及发布 pilot（后续授权切换到 VPS 新身份，正式 build 2）。

## 完成证据与剩余边界

- Node 24：全套 374 项，327 通过、47 跳过、0 失败；更新核心用例 35 项。前端构建、TypeScript 检查通过。
- Windows PowerShell 5.1 的真实助手验证覆盖篡改拒绝，以及父进程退出后继续运行；测试路径包含空格和单引号。采用系统 `Start-Process -WindowStyle Hidden`，不用会导致 PowerShell 提前退出的 `DETACHED_PROCESS`。
- 真实打包 Electron 验证旧 IPC 拒绝、新 IPC 参数限制、独立 profile 共享缓存、崩溃忙碌窗口阻断、签名撤回和 NSIS 安装后的内嵌 build 确认。安装身份与应用 ID 均与正式客户端隔离，测试结束卸载测试产品。
- 最终隔离安装验收退出码 0、`installation: true`：`.local/managed-client-acceptance/2026-10-23T02-20-47-842Z/evidence.json`，日志 `.local/managed-client-acceptance.log`。同目录 `about-build-2.png` 为验收后从同一 build 2 打包程序补拍的关于页面（解包运行仅补充 UI 截图，不作为安装证明）；原 `upgraded.png` 捕获到了尚未刷新的旧画面。原生截图现等待窗口显示后再捕获。
- 原生交互取消与重试验收通过：`.local/managed-client-acceptance/2026-10-23T02-29-44-261Z/evidence.json` 同时记录 `cancellation: true` 与 `installation: true`，日志为 `.local/managed-client-interactive-cancel.log`。使用 `--interactive-cancel`，首次安装保持原助手交互行为，由用户实际点击取消；脚本确认安装器非零退出、磁盘及重启客户端仍为 build 1、pending 为 unconfirmed、无 last-install 成功记录并且可重试，然后真实重新安装到 build 2 并完成目标启动确认。取消后状态保存在同目录 `after-cancel.json`，失败诊断归档为缓存中的 `pending.json.cancelled.failure.txt`。
- 测试安装使用临时密钥和 loopback HTTPS；只有自动安装及交互取消后的重试阶段对测试助手加入 `/S`。当前会话没有 computer-use 所要求的 `node_repl` 工具，原生按钮由用户手动点击，检查和重试由脚本执行；测试结束卸载独立测试产品。
- 源码提交 `640588de87f73acffbec2e3e50b8d757412f24a6` 已推送至 benvyf 仓库；正式 build 1 引导包已从独立清洁 worktree 构建，打包脚本退出码 0、实际打包启动测试 1/1 通过，生产身份、生产公钥、交互助手及制品 hash 核对通过。大小、SHA256 和本机证据目录见 [构建记录](../../UPDATE-CLIENT-BOOTSTRAP.md)。
- 后续用户授权更换生产身份、集中到 VPS 保管：正式 build 2 已从清洁提交 `4a39bc3` 重新打包并发布到 pilot revision 3；stable revision 2 仍为空，旧密钥已退役。详见 [正式发布记录](../../UPDATE-CLIENT-BUILD-2.md)。本计划的“验证边界”描述原实施阶段，后续发布按新增授权完成；六台 Ubuntu 未迁移，协议 19 → 20 仍需管理员人工配套引导。
