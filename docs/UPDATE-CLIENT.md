# Windows 定制客户端更新

本实现属于交付 C。主进程使用 Chromium 网络栈访问固定 HTTPS 通道，复用 [签名契约](UPDATE-SIGNING.md)，不依赖 CC 服务端是否连接。旧 `service:upgrade`、`update:install`、`release:notes` IPC 继续拒绝。

## 打包与身份

公开构建配置是 [managed-client.json](../deploy/managed-client.json)。首个 pilot/build 1 引导包已从清洁提交构建并核对，尚未发布；见 [构建记录](UPDATE-CLIENT-BOOTSTRAP.md)。Windows 打包器从清洁 Git 工作树读取完整提交、应用三段版本和协议，校验公钥及源地址后写入应用资源。源码变化后必须重新构建；不能修改旧 EXE 的索引冒充新 build。

生产构建前提交并整理源码，在 Node 24 环境准备项目依赖、Electron、OpenSSH 和 PowerShell，按现有流程运行 `npm run package:windows`。工作树不洁、配置缺失或公钥非法时失败。普通开发运行及非 Windows x64 平台不启用安装。更新身份不从运行环境或 renderer 读取。

生产私钥、管理令牌不参与客户端构建。当前配置使用既有公开身份，不生成新生产密钥。

## 用户操作

连接前可通过“打开设置”快捷键（默认 `Ctrl+,`，macOS 为 `⌘,`）进入本机设置，再打开“关于与更新”；连接后从设置进入。登录页不显示常驻的服务端更新检查，服务端维护从“关于与更新”发起，并在独立弹窗中完成。页面显示定制 build、固定通道、协议和纯文本发布说明，提供检查、下载、取消和安装操作。

启动延迟 30 秒；同一安装自动查询间隔至少 6 小时，手动至少间隔 30 秒。查询不会自动下载。协议不匹配时，登录页显示“处理连接版本不匹配”，可进入“关于与更新”处理，即使设置快捷键已禁用或清空也可恢复；此入口不自动检查或安装更新。

安装前需要先断开此安装的**所有远端连接**，结束任务、原生终端及登录流程。此首版不会代用户中断连接或终止任务。主进程同时核对进程清单和各窗口的新鲜活动报告；未知、过期或忙碌状态都会拒绝安装。准备阶段冻结新连接并协调窗口退出，15 秒内未退出则取消，不杀进程。

安装前重新请求有效索引、验证撤回和完整文件 hash。外置助手复制到缓存目录，由 Windows 系统 PowerShell 通过 `Start-Process -WindowStyle Hidden` 创建独立进程，避免占用安装目录中的内置 PowerShell 文件，也避免 PowerShell 5.1 在 `DETACHED_PROCESS` 下不执行脚本便退出；助手使用 ASCII 源码和显式系统模块路径。助手再次检查文件、缓存重解析点和残余进程，再启动交互 NSIS 安装器。系统策略阻止助手时保留失败诊断，不放宽机器级策略。

## 共享状态与诊断

缓存目录为 `%LOCALAPPDATA%/CC-Desk-Tunnel/updates/{installationId}`。ID 取真实 EXE 目录规范化后的 SHA256，与每个连接的 user-data-dir 无关。若 Windows 对桌面应用实施文件系统虚拟化，先拒绝实际符号链接，再统一使用系统返回的物理缓存路径。Windows 命名管道充当进程操作锁；所有权随进程退出或崩溃释放。

- `ledger-pilot.json` / `ledger-stable.json`：签名 revision、payload hash、最高候选身份及已确认 build。
- `state.json`、`instance-{pid}.json`：共享操作状态和窗口活动报告。
- `download-{build}-{hash}.part`、`ready.exe`、`ready.json`：受限续传与已校验候选。
- `pending.json`：目标 build、原 build、安装器 hash、助手 PID。取消或失败不视为成功。
- `last-install.json`：目标内嵌 build 实际启动后的成功记录。
- `pending.json.failure.txt`：外置助手失败原因。
- `pending.json.helper.log`：助手等待退出、校验和安装器退出的时间记录。
- `pending.json.helper-stdout.txt` / `pending.json.helper-stderr.txt`：助手输出，包含脚本初始化或解析错误；错误输出可能为 PowerShell CLIXML。

状态原子写入。不要为了绕过防回放而删除 ledger；不要手改缓存来安装。pending 只由目标 build 启动确认；安装器退出码为 0 也不能提前确认。

## 验证

控制器与网络核心测试：

```powershell
node --test apps/desktop/test-main/managed-client.test.mjs apps/desktop/test-main/managed-updates.test.mjs apps/desktop/test-main/update-contract.test.mjs
```

隔离真实 Windows 安装验证：

```powershell
node scripts/verify-managed-client.mjs
```

后一个脚本生成临时签名身份、仅绑定 loopback 的 HTTPS 服务和独立测试应用 ID，构建两个测试安装包，在 `.local/managed-client-acceptance/` 下安装并使用独立 profile 验证真实 Electron、旧 IPC 拒绝、新 IPC 参数限制、共享缓存、忙碌阻断、签名撤回和 build 1 → 2 确认。仅测试进程通过 Playwright 注入固定测试证书信任；正式应用无测试开关。自动升级验收在测试包中将交互安装改为 `/S`，不代表交互取消已验收。

交互取消与重试验收：

```powershell
node scripts/verify-managed-client.mjs --interactive-cancel
```

此模式复用隔离安装环境，先保留原助手的交互安装行为。日志出现 `ACTION_REQUIRED_CANCEL` 后，在名称包含 `CC Managed Update Acceptance` 的测试安装窗口点击取消，并确认退出。脚本最多等待 15 分钟，然后核对安装器非零退出、磁盘及重新启动的客户端仍为 build 1、pending 未确认、没有成功记录且可重试；最后自动重试安装到 build 2 并验证启动确认。只有重试阶段的测试助手加入 `/S`。证据包含 `after-cancel.json`、`evidence.json` 及归档的取消失败诊断。

2026-10-23 验证通过：既有更新核心 35 项；全套 374 项中 327 通过、47 跳过、0 失败，前端构建及 typecheck 通过。真实 Electron 与 NSIS 安装验收包含共享缓存、崩溃忙碌窗口阻断、签名撤回、build 1 → 2 安装及目标启动确认。新增交互验收也已通过：用户实际点击取消，脚本确认旧版能启动且未误报成功，并真实重试升级到 build 2；记录见 [实施计划](superpowers/plans/2026-10-23-update-client.md)。

脚本结果和截图保存在该次独立目录；测试包不能上传生产通道。正式 build 1 引导包已从提交 `640588de87f73acffbec2e3e50b8d757412f24a6` 构建并核对，下一步由管理员生成生产签名索引并发布 pilot。协议 19 → 20 人工引导、服务端迁移及六台扩展另行执行。
