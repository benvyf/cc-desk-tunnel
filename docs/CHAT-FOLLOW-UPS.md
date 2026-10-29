# 忙碌发送与对话导航

## 发送方式

- 空闲时，Enter 或发送按钮立即发送消息。
- Claude Code 运行中，默认 Enter 和发送按钮为「排队发送」：当前运行正常完成后，按顺序逐条发送，每条等待其运行完成再发送下一条。
- Ctrl+Enter（macOS 为 Cmd+Enter）使用与当前设置相反的方式；Shift+Enter 换行，输入法组词时 Enter 不发送。
- 可以在输入框旁或「设置 → 常规 → 消息发送」切换默认方式，设置在此电脑的连接窗口间共享。
- 「插话发送」复用现有 Claude Code streaming input。发送请求成功不代表模型已经处理；具体接收与处理时机由 Claude Code 决定，沿用消息回执展示。
- 排队列表支持编辑、移除、提前发送；编辑时暂停自动发送，保存或取消后点击「继续排队」。正文编辑保留附件引用，仍检查含附件的消息长度。
- 手动停止、运行失败、断线后，排队暂停，需要确认后继续。未确认的发送不自动重试，手动重试使用相同 requestId，沿用服务端持久去重；已经尝试发送的消息不能修改正文后沿用该 ID。
- 排队由当前窗口执行，需保持窗口打开。刷新当前页面后可恢复暂存消息，但需要点击「继续排队」；完整退出客户端后不保证保留排队消息。不同会话的队列独立，切换会话不改变发送目标。

## 导航条

右侧等间距刻度对应当前加载的用户消息；当前阅读位置使用较长刻度。悬停或键盘聚焦显示问题和回复预览，点击刻度定位消息。定位后暂停自动跟随新输出，点击「回到底部」恢复。

预览里的书签按钮保存本机标记，书签通过刻度颜色区分。当前阅读或预览项形成波峰，两侧逐级缩短；使用缩放动画，减少布局开销。方向键移动刻度焦点，Home / End 选择首尾，Enter 定位，Escape 关闭预览。历史未加载完时可使用刻度顶部的「···」加载更早记录，沿用原有分页和阅读位置保持逻辑。

## 侧栏宽度

侧栏与聊天区之间的分隔线支持拖动，宽度范围 264–420px，默认 284px；较小窗口会限制最大值，尽量为聊天区保留 400px。松开后保存本机偏好，双击恢复默认，左右方向键每次调整 10px。按 Escape、收起侧栏、窗口失焦或缩放会取消当前拖动。700px 以下继续采用浮层侧栏，不显示拖动手柄。

## 参考与验证

交互参考 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：

- `packages/client/ui-conversation/src/client/input/submission-policy.ts` 的默认排队、互补快捷键和发送按钮行为。
- `packages/client/ui-chat/src/client/chat/TurnNavigator.tsx` 的固定间距刻度、阅读位置标记和问题/回复预览。

实现复用本项目消息协议、Claude Code 输入和历史分页，没有引入其运行时或插件体系。仅需更新客户端，现有兼容服务端可以继续使用。

验证：`node --test apps/desktop/test-main/follow-ups.test.ts`、`npx playwright test apps/desktop/test/follow-ups-navigation.spec.ts`、`npm run typecheck`、`npm run build`。交互测试使用模拟 WebSocket，不调用模型服务。
