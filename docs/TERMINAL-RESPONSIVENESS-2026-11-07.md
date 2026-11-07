# 终端响应与窗口适配（2026-11-07）

基线 `edeff2b`。只改桌面端；服务端、协议和官方 Claude Code 的行为、设置均不变。

## 背景

官方 Claude Code 2.1.295 默认使用全屏界面：交替屏幕（`?1049h`）加鼠标上报 `?1000h ?1002h ?1003h ?1006h`（见 `test/fixtures/terminal-echo/linux295.json`）。因此：

- 滚轮不在本地滚动：每一格都作为 SGR 鼠标报告发给 CLI，由它重绘后传回，延迟等于一次往返加重绘。
- 1003 任意移动上报：鼠标经过终端的每一格都产生一条 `terminal.input`。
- 这些报告原先进入输入预测，被当作未知编辑，预测被撤下并等待远端画面确认，打字时会感到回显变慢。

反复最大化/还原/全屏时，原有适配在尺寸暂缺时不重试或只重试一帧，且主进程只用最大化事件切换按钮图标，不触发重新测量。

## 改动

| 项目 | 行为 |
| --- | --- |
| 被动鼠标报告 | `passiveMouseReport` 只认 SGR 滚轮（按钮码含 64、不含 128）和未按键移动（含 32、低两位为 3）。不经过预测；点击、拖动、X10 编码和夹带其他字节的数据仍按原路径。 |
| 上行合并 | 第一条立即发送；其后 16ms 内移动只保留最后位置，滚轮按原顺序拼接（不丢格）。任何非鼠标输入先发出排队的鼠标数据，再单独发送自身，中断键仍是单独一条消息。 |
| 窗口事件 | 终端窗口在 `maximize/unmaximize/restore/enter-full-screen/leave-full-screen/resized/moved` 时沿用 `terminal-window:state` 通知；当前标签重新测量。连续的 `resize/move` 不转发。 |
| 适配重试 | 宿主暂时没有尺寸或字符度量不可用时逐帧重试，最多 30 帧；窗口 `resize` 后 150ms、450ms 再测量。隐藏标签不测量。 |
| 重新适配窗口 | 运行中的终端工具栏新增刷新图标：本地重新测量；远端先发少一列，150ms 后按实测尺寸发送，若仍未发送则 300ms 后补发原尺寸，使 CLI 收到两次不同尺寸并重绘。 |

未采用：替用户把 CLI 切到经典渲染（`CLAUDE_CODE_NO_FLICKER=0` 等）或关闭鼠标捕获。经典渲染下现有预测不识别输入框，且属于改变官方 CLI 的设置；需要本地滚动的用户可在终端执行官方命令 `/tui default`，恢复用 `/tui fullscreen`。终端与聊天共用 WebSocket、独立窗口与主窗口共用渲染线程两项，先不改架构。

## 验证

沙盒 Node 22 + chrome-headless-shell：类型检查、格式检查通过；`terminal-prediction`、`terminal-window` 单元测试；Playwright `native-terminal`（含鼠标合并、重新适配、尺寸暂缺后恢复）、`terminal-predictive-echo`、`terminal-usability`、`terminal-status`、`terminal-close`、`terminal-workspace`、`terminal-projects`、`terminal-preview-chrome`。

未验证：Windows 真实窗口的最大化/全屏切换、真实网络下的手感、`terminal-window.spec`（需要 Electron 可执行文件）。

## 补充：终端显示方式与往返审查（同日）

### 终端显示方式

“设置 → 常规 → 终端显示方式”：**滚动模式**（官方经典渲染，输出留在本机滚动缓冲，滚动、选中复制和查找没有网络往返）与 **整屏模式**（官方 fullscreen 渲染）。默认滚动模式；说明文字写明与窗口是否最大化无关，只对新开的终端生效。

服务端在 `ready` 中声明 `terminalDisplay: { version: 1 }`；客户端只向声明了它的服务端、且只在新开进程（非接回原终端）时发送 `terminal.open.display`。服务端通过官方 CLI 自己的开关应用：在该终端的 `--settings` 文件写 `tui: "default" | "fullscreen"`，并设 `CLAUDE_CODE_NO_FLICKER=0/1`。旧服务端不会收到这个字段（`terminal.open` 为严格校验），保持 CLI 自身设置。`tui` 设置键与说明取自官方 SDK 0.3.286 的设置类型；未在真实 CLI 上验证，需要升级服务端后实际确认。

滚动模式下输入预测不生效（预测只识别整屏模式的输入框），设置说明已注明。

### 往返审查结论

逐段检查了按键到回显的路径，没有发现可安全去掉的额外等待：

| 环节 | 结论 |
| --- | --- |
| 渲染页 → 主进程本地桥（回环 WebSocket）→ 服务端 WSS | 两端 `ws` 8.22 均 `setNoDelay()`；TLS 包装的代理套接字同样转到底层 TCP，不存在 Nagle 叠加延迟确认 |
| 消息解析 | 主进程与渲染页各做一次 JSON + zod 判别联合解析：小帧约 3 µs、16 KB 帧约 14 µs |
| 服务端接收 | 按收到顺序同步处理，终端输入不进入请求队列，直接写 PTY |
| 服务端输出 | 首段起最多合并 5 ms（为避免半帧重绘），保留；ACK 只影响 128 KiB 背压，不影响回显 |
| nginx 模式 | `proxy_buffering off`，WebSocket 代理默认 `tcp_nodelay on` |

剩余延迟主要由网络往返（含系统代理线路）与 CLI 重绘决定。终端状态提示（鼠标悬停右上角状态）新增“按键到画面更新约 N ms”：最近 20 次按键到该终端下一次输出的中位数，用来判断慢在哪里；没有按键等待时的输出不计入。主进程日志中 `Reached … through the system proxy` 表示连接经过系统代理，代理线路绕远会直接增加每次往返。
