# CC 多标签终端实施记录

日期：2026-10-29（香港时间）。基线：`416d0bb`，分支 `codex/terminal-status-coordination`，工作目录 `D:/cc-desk-tunnel/.local/terminal-status-fix`。

## 交付与边界

已实现 [实施方案](MULTI-TERMINAL-IMPLEMENTATION-PLAN.md) 的源码开发部分：独立窗口中的合并标题栏、多标签、新建、切换、别名、完整列表、选项目创建、单个/全部关闭、自然退出保留输出、断线结束、主窗状态协调，以及服务端创建/状态确认/所有权/容量与能力协商。未制作正式安装包、发布、安装或操作生产节点；未启动真实 Claude 或连接真实 provider。

按 karpathy-guidelines 复用现有 Portal、xterm、WebSocket、SQLite 与模拟 PTY 测试。没有新状态库、通用终端框架、分屏、拖出窗口、进程恢复、输出存档、账号调度、额度扩展或 API 计费变更。

集合由主渲染器中稳定挂载的 TerminalWindow 持有；App 只保留工作区入口和活跃摘要，通过窄控制句柄唤回标签及协调关闭。这是对原计划状态放置位置的实现调整：集合不必搬进体量较大的 App，但必须挂在页面分支之外，切换设置/定时任务不卸载任何终端。此行为有主窗回归覆盖。

## 接口与数据

- 协议保持 22。握手增加可选 `terminalWorkspace: { version: 1 }`，无声明时保留单终端，不试探新命令。
- `terminal.session.create` 明确来源与设置，不清空订阅，不切换主窗选中项。服务端解析来源设备/项目，创建和权限/model/effort 在同一 SQLite 事务保存后才允许启动。
- 新增 `terminal_creations` 表，保存 requestId、内容签名和会话 ID。相同请求持久复用结果，内容冲突拒绝；重启和事务失败有回归。不增加后台任务系统。表不含凭据。
- `terminal.state` 只读返回当前连接可控制的 opening/running/closing/absent；其他 owner 或不匹配身份返回 unavailable，不泄漏 terminalId。每次新观测用新 requestId，最多连续确认三次，未确认保留标签供手动处理。
- 控制错误附 sessionId/terminalId；closed 提供 process_exit/user_close/ack_timeout/disconnected/control_error 已知原因。异常控制关闭不会冒充用户关闭。
- 新标签使用服务端返回的项目身份；后续 `+` 沿用该身份。别名只在当前工作区有效。底栏分开标注连接节点、项目设备与项目目录，不把项目目录冒充 CLI 实际工作区。
- 继续使用每会话互斥、owner connection、原有节点并发配置、128KiB 背压、30 秒确认期限及每实例 2000 行 scrollback。隐藏标签继续处理输出，只有当前标签接收输入及尺寸调整。
- 新增窗口控制、活跃标记、关闭协调和最大化状态的窄 IPC，仅映射调用主窗所拥有的子窗口；终端子窗口仍无 desktop bridge、Node、文件或命令权限。
- 终端启动入口已移除 completeOnboarding 依赖；不读取 token 或自行修改引导完成标志。官方 CLI 自己的正常引导/认证保留；其他已有 SDK 路径未因本功能自动获得许可。

## 验收依据

测试均使用合成终端消息、模拟 PTY 或本机 Electron 测试窗口，不带生产账号和真实提示词。

| 编号 | 本次证据 | 限制 |
| --- | --- | --- |
| C1/C2 | terminal-workspace 浏览器回归：独立输入/ack、隐藏输出、切换/别名保持实例和 open 次数 | 未替代真实节点资源观测 |
| C3 | 浏览器隐藏标签输出超过 128KiB；Electron 最小化超过 30 秒后继续正确 ack | 真实受限内存节点仍需试点 |
| C4/C5 | terminal-close、native-terminal 与 workspace：自然退出、关闭中先退出、真实关闭失败、部分失败、丢失 opened/response 与状态确认 | 断网未收到的输出不能恢复 |
| C6 | 持久创建签名、重启复用、事务回滚、创建响应丢失重试、创建中关闭、StrictMode 延迟挂载 | 无后台进程恢复 |
| C7 | 服务端拒绝其他连接控制/查询身份；窗口控制协调测试；Electron 子窗无 desktop/opener | 系统级多用户隔离仍属既有部署门槛 |
| C8 | 浏览器断线保留标签且不重开；Electron 窗口关闭取消、确认、重新打开；控制器退出协调取消测试；App 断开/换节点共用 closeAll | OS 强制终止、实际 SSH 衍生任务收尾需现场验证 |
| C9 | 服务端来源解析与权限先保存后启动核对；浏览器选新项目后使用返回身份，后续 + 来源正确；创建接口无订阅修改 | 跨设备真实 SSH 离线/收尾仍需试点 |
| C10 | 两个模拟进程达到容量，第三个被拒，释放后可启动；控制错误只结束目标进程 | 未提高生产容量 |
| C11 | terminal-status 主窗回归：读取时不能启动、打开不额外读取、最后进程自然结束后恢复读取，设置/任务页面切换不重开或关闭 | 受管升级原有 busy 条件保留 |
| C12 | 以 git 基线旧 schema 实测 ready/closed/connection.error 新字段兼容；新客户端无能力声明退回单终端；新接口服务端模拟与客户端 fixture 分别通过 | 正式制品组合验收待打包阶段 |
| C13 | Electron 真窗口 480×300、125% 缩放、20px 字号、主题同步、窗口 resize/maximize/minimize、中文长粘贴、Ctrl+C；取消按钮默认焦点 | 不宣称已覆盖全部 OS/DPI/输入法组合 |
| C14 | 官方 CLI 参数与受管审核模拟测试；启动路径不触碰 onboarding 的断言；新建/切换无新增 SDK/prompt；新 UI 只用纯文本/React/xterm，未新增输出或认证日志 | 全项目 SDK/订阅关系与生产账号/地区等 P0 事项尚未关闭 |

核心命令：

```powershell
node --test apps/server/test/terminal-controls.test.ts apps/server/test/terminal-creation.test.ts apps/server/test/native-terminal.test.ts apps/desktop/test-main/terminal-window.test.mjs
node --test apps/desktop/test-main/client.test.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run build
node node_modules/@playwright/test/cli.js test apps/desktop/test/native-terminal.spec.ts apps/desktop/test/terminal-close.spec.ts apps/desktop/test/terminal-status.spec.ts apps/desktop/test/terminal-workspace.spec.ts apps/desktop/test/terminal-window.spec.ts --reporter=line
```

Node 核心文件合计 38 项通过；浏览器/Electron 核心 15 项通过。后续针对页面稳定挂载、主题/字号同步、控制失败归属及小窗口几何位置的定向验证均通过。TypeScript 检查与生产构建通过；构建保留原有 RichText 混合静态/动态导入及大 chunk 提示，不扩大为无关打包重构。

本机正常窗口截图在 `.local/terminal-window.png`，浏览器小窗口截图在 `.local/terminal-workspace-small.png`。Electron 在 125% 缩放下的截图存在像素裁剪，最小窗口以 `.local/terminal-workspace-layout.json` 和通过的几何断言为依据：480×300 原生窗口对应 384×240 CSS 视口，20px 根字号下三个窗口按钮与底栏均在视口内。旧 schema 验证临时文件在 `.local/terminal-legacy-protocol.ts`。这些是测试产物，不加入版本库或安装包。工作区依赖原先指向另一检出的 node_modules，本次只在本工作区建立独立的依赖链接并指向本地 protocol/server/desktop，未修改其他检出。

源码提交：`4f58892`（创建/状态契约）、`b8dee29`（独立生命周期与结果确认）、`cb45e40`（标签工作区和窗口协调）。

## 发布前仍需完成

P0 的真实使用关系、适用政策版本、账号/地区/用途资格、既有 SDK/订阅组合处置和目标 CLI 来源/完整性需要核实。本轮模拟开发不代表这些事项通过。

完成 P0 后再准备具体正式安装包、服务端制品摘要、兼容组合与回滚包；先确认目标节点空闲和配置，再做用户授权的单节点试点，验证实际 Linux/SSH 子进程清理、资源和受管 hook，最后逐节点扩展。

数据库变更为新增表，旧版本可忽略；回滚程序前先结束多标签进程，按既有私有流程备份数据/配置，保留项目与 CLI 历史，不重放输入。不使用 force、清 busy 或杀其他用户进程绕过升级要求。
