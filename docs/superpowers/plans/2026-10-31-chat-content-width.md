# 聊天正文拖动调宽实施计划

> 按 executing-plans 在本会话逐项执行。实现阶段不包含发布、推送或合并；验收后按用户的后续明确授权以中文说明提交、合并并推送主分支，不包含安装包或远端部署。

**Goal:** 主聊天正文可对称拖动调宽，输入区域联动，提示轻量且不引入逐帧聊天重渲染。

**Architecture:** 独立 ConversationWidthControls 管理指针与布局；chatWidth.ts 处理范围及安全本地存储；共享 CSS 变量连接原有 UI。

**Tech Stack:** React、TypeScript、CSS、Node test、Playwright/Edge，沿用已有依赖。

### 1. 定义宽度及存储规则

- [x] 新建 `apps/desktop/test-main/chat-width.test.ts`，验证 `resolveChatWidth(1600, null) === 820`、`resolveChatWidth(1000, 1200) === 880`、非数字存储回退及写失败不中断。
- [x] 用 `node --test apps/desktop/test-main/chat-width.test.ts` 观察缺失模块失败。
- [x] 新建 `apps/desktop/src/chatWidth.ts`，使用 `Math.min(Math.max(640, preference ?? 820), Math.max(640, column - 120))`；安全本地读写，不依赖 Electron 或网络。
- [x] 重跑单测确认范围及存储契约。

### 2. 控件与主聊天接入

- [x] 新建 `apps/desktop/test/chat-width.spec.ts` 和必要 fixture，先运行双侧拖动用例，确认手柄缺失失败。
- [x] 新建 `apps/desktop/src/ConversationWidthControls.tsx`，通过 pointer capture 和 RAF 写 CSS；完结清理、取消恢复、滚轮转交、键盘语义及存储失败降级。
- [x] 在 `Conversation.tsx` 增加可选主聊天调宽开关，仅 `App.tsx` 主聊天启用；给 main 标记 `.chat-workspace`。侧边会话不挂载此控件。
- [x] 在 `style.css` 让原 820px 聊天相关上限消费 `var(--chat-content-width, 820px)`，队列上限减去原有 28px 内缩。补充主聊天对称留白及渐隐手柄，窄列隐藏且不留键盘焦点。
- [x] 重跑拖动测试，并补持久化、取消、键盘、缩窗及流式跟随回归。

### 3. 审阅与验证

- [x] 浏览器实测明暗提示截图、长正文、导航/引用/输入、两侧栏和侧聊天隔离。
- [x] 记录拖动期间 0 次偏好写入及提交 1 次、每帧更新合并、长对话输入与拖动耗时；不把测得无异常写成零开销。
- [x] 执行 `npm run typecheck`、`npm run build`、相关单元/UI 回归、格式和差异检查；完整单测若仍有已知发布历史缺项，单独记录，不伪造修复。
- [x] 独立代码 review 并修复发现的问题；文档记录实际证据及局限。保留工作分支供用户后续提交/推送。
