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
