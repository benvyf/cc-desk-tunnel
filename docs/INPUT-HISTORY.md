# 输入框指令历史

普通聊天输入框支持用方向键复用**当前会话**的指令，主聊天和侧边聊天都可使用。同项目中的其他会话也不会混入。

- ↑ 浏览较早的指令，↓ 返回较新的指令。
- 回到最新端时恢复浏览前的草稿和光标位置；切换会话或关闭当前输入视图时会先恢复原草稿。恢复时沿用原草稿的条件更新，不能覆盖其他视图新写的文字。单纯失焦不恢复，以便点击发送按钮时仍发送当前调出的指令。
- 调出的文字只填进输入框，不自动发送。编辑后开始新一轮回溯，会保留编辑后的临时草稿。
- 多行文字仅在首个逻辑行的 ↑ 或最后逻辑行的 ↓ 进入历史；其余位置保留移动光标的行为。逻辑行按换行符划分。
- 有选区、带 Ctrl/Alt/Meta/Shift、中文输入法正在组合文字时不切换历史；斜杠菜单打开时 ↑/↓ 仍选择菜单项。

组合输入优先级借鉴 Harness：记录 compositionstart/end，结合键盘的 isComposing、keyCode 229 和结束后 10ms 短保护，统一挡在菜单、回溯和发送之前。保护期间阻止按键向应用层冒泡，避免结束 Esc 被全局双 Esc 停止误计数；浏览器输入法默认行为保留。只有组合已经结束、落在保护窗口内的普通 Enter 才阻止 textarea 默认换行；组合中的候选操作和 Shift+Enter 保持原生处理。状态在切换会话时重置，不增加定时器。

历史直接来自本会话已加载的用户消息和待发送队列，沿用已有会话与队列持久化，不另存一份指令库，也不增加远端接口。刷新后重新加载会话即可继续使用；更早但尚未加载的消息，需要先通过会话原有入口加载。

客户端启动时，会先读取本机已保存草稿；读取完成前暂不启用方向键回溯，避免历史预览被误当成新编辑、覆盖正在读取的原草稿。此时仍可正常打字，已有的草稿合并规则继续保留附件与引用。

最多提供最近 200 条可用正文，跳过空白、连续重复项和超出当前输入长度上限的旧文字。服务端“继续运行”的内部模板不作为用户指令。队列项已经生成正式消息时，即使投递回执尚未回来，也通过消息身份去重。

含附件或引用的旧消息只调出用户正文，不自动重新挂载旧附件和引用，也不把包装元数据放进输入框。当前草稿的附件和引用保持独立。失败而未进入会话记录的发送不进入历史。

此功能用于已有会话的普通消息框；尚未创建会话的首页输入框没有历史，原生终端方向键继续由对应 CLI 处理。

## Harness 源码核对

核验上游 HEAD：`ce7073d51254c26cd63b22a60835b8f948deb447`。

该版本网页输入路径没有找到“用 ↑/↓ 调出已提交指令”的实现：

- [keymap.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/client/ui-conversation/src/client/input/editor/keymap.ts)：方向键先交给补全菜单 arbitrate；返回 pass 时交还编辑器。
- [facade.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/client/ui-conversation/src/client/input/facade.ts)：转发菜单仲裁；提交时清理编辑器撤销历史。
- [runtime.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/client/ui-conversation/src/client/input/editor/runtime.ts)：这里的 history 是 Lexical undo/redo，不是已提交指令列表。
- [stores.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/client/ui-conversation/src/client/stores.ts)：按会话保存草稿。
- [hub.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/client/ui-conversation/src/client/input/hub.ts#L183)：恢复草稿后才返回会话输入对象。CC SPACE 的本机 IPC 为异步读取，因此使用现有读取就绪标志保护回溯，不改写成上游的同步存储或 SessionInputShell 体系。

CC SPACE 原先也只为斜杠菜单处理方向键。本次沿用已有 textarea 和会话记录补齐回溯，不引入上游编辑器或插件运行时。

最小借鉴范围是草稿恢复顺序、会话隔离、菜单/输入法优先与较晚回执的草稿保护。↑/↓ 指令复用继续由 CC SPACE 的会话消息提供，不新增独立历史持久化库。

## 验证入口

使用 Node 24：

```powershell
node --test apps/desktop/test-main/input-history.test.ts apps/desktop/test-main/quotes.test.ts apps/desktop/test-main/follow-ups.test.ts apps/desktop/test-main/attachments.test.mjs
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm run test:ui -- apps/desktop/test/input-history.spec.ts apps/desktop/test/quoted-conversations.spec.ts apps/desktop/test/follow-ups-navigation.spec.ts apps/desktop/test/slash-commands.spec.ts apps/desktop/test/composer-reveal.spec.ts
npm run typecheck
npm run build
```

浏览器测试使用模拟会话服务，不调用真实模型。本次不生成安装包、不合并或推送 main。

2026-11-03 验证：核心 7/7，输入历史与侧会话功能界面 18/18，加上 2 项草稿读取/附件交互回归均通过；连同引用、队列和附件共 16/16 项相关 Node 测试通过。细节审查发现并修复本机草稿读取完成前回溯可能覆盖已保存正文的问题。当前主、侧输入框均等待草稿读取完成再启用回溯，普通早期打字和附件合并照常。

细节复核后的相关界面运行 96/96 通过，显式排除了上轮已确认基线失败的 1 项发送方式菜单快速重开用例；该既有用例曾在 HEAD 版 App/Composer 中相同位置失败，本轮没有调整其 50ms 关闭保护。类型、格式、diff 和前端构建通过；独立审查的继续标记、切换草稿恢复、队列身份去重、草稿读取时序和结束 Esc 全局误计数问题均已修复。

新增 5 项组合输入回归覆盖：事件漏报组合标志、结束确认键、会话切换后的状态重置、Chromium 原生组合链路，以及结束 Esc 不计入全局停止序列。原生用例在受控的浏览器时钟下核验结束保护窗口，避免工具往返耗时导致误判；它不能代替 Windows 物理输入法及候选窗口的人工验收。
