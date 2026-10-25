# Claude网页最小嵌入 Implementation Plan

**Goal:** 在Build9基础上提供Chat/Coding切换和经已验证服务连接传输的远端浏览器画面，禁止本地官网旁路。

**Architecture:** React使用本地打包noVNC；Electron主进程经固定服务地址、证书校验和认证首帧桥接独立二进制通道；Ubuntu服务只转发管理员配置的浏览器上游。不开新公网端口、不修改业务持久化协议、不绕过审核。用户已明确仅账号本人使用自己的账号，授权开始最小嵌入开发。

**Tech Stack:** Node24、Electron、React、TypeScript、ws、固定版本noVNC。

范围：本次完成可测试的显示和交互闭环；不部署、不发布、不访问真实Claude，不实现官网脚本/扩展、自动登录、文件通道或DOM隐藏。中文/附件/自动登录识别按完整方案后续交付，本次界面明确当前能力。

## 执行清单

- [x] 核对个人自用、干净Build9基线；创建codex/claude-web分支；既有配置/连接/品牌23项基线通过。
- [x] 服务端：未认证拒绝、默认关闭、强制审核拒绝、单控制者、超过256KiB字节流、无上游请求先于认证；新增独立browser-service.ts和server/config最少接线。上游只由管理员配置，用户请求不得提供URL。
- [x] 主进程：错误证书不发凭据、固定路径、nonce/Origin、二进制往返和拒绝重定向；实现browser-bridge.mjs，并在原CC连接结束时销毁。
- [x] 客户端：Chat/Coding切换、草稿保留和无本地请求UI测试；新增ModeSwitch、ClaudeWebPage及Sidebar/App小接线；固定noVNC版本入包，隐藏不销毁远端页面。
- [x] 旁路：测试并限制Chat期间外链handler，禁止本机打开目标网站；React只得到回环随机地址，不得到官网URL或Cookie。
- [x] 验证：Node24相关单元/集成测试、TypeScript、生产构建、Playwright真实界面；审查diff及截图。所有fixture均为离线/回环服务。
- [x] 交付运行说明、管理员配置示例、未部署边界及首阶段验收结果；原JEV节点仍默认拒绝网页入口。

建议新增文件：apps/server/src/browser-service.ts、apps/server/test/browser-service.test.ts、apps/desktop/electron/browser-bridge.mjs、apps/desktop/test-main/browser-bridge.test.mjs、apps/desktop/src/ModeSwitch.tsx、apps/desktop/src/ClaudeWebPage.tsx、apps/desktop/src/novnc.d.ts、apps/desktop/test/claude-web.spec.ts。

最少修改文件：server.ts/config.ts、desktop main.cjs/preload.cjs/desktop.d.ts、App.tsx/Sidebar.tsx/style.css、desktop package.json和package-lock.json、部署/功能说明。新增客户端依赖使lockfile变化，现有受管程序升级不得绕过其兼容校验；上线须由管理员评审镜像交付。

检验命令使用bundled Node24：node --test apps/server/test/browser-service.test.ts apps/desktop/test-main/browser-bridge.test.mjs；node node_modules/typescript/bin/tsc --noEmit；node node_modules/vite/bin/vite.js build --config apps/desktop/vite.config.ts；node node_modules/@playwright/test/cli.js test apps/desktop/test/claude-web.spec.ts。

## 执行记录

- 全量Node测试：554项，519通过、35按平台或既有开关跳过、0失败。随后新增Origin/nonce和重定向回归；最终相关28项全部通过。新模块独立16项通过。
- TypeScript通过，生产构建通过；仍有既有主入口大于500kB的构建提示。noVNC按连接时加载，独立约187kB。
- 真实Chrome/Playwright和Electron共4项通过：原Coding聊天/审批流程、Electron沙箱、切换保留草稿、完整正式main/preload/IPC经TLS CC服务到离线RFB的像素/键鼠往返；按住Shift切换释放、无重建连接、人工暂停、断线及本机外链拒绝。
- `stageDesktop`的前端/桥接打包和依赖导入通过，确认browser-session.cjs、noVNC许可证及NOTICE入包。未生成安装器或发布构建。
- 独立代码审查发现的空值首帧崩溃、静默通道、按键释放、旧可见状态、并发打开关闭及控制连接取消时序均已修复；补充nginx可选路由。
- 说明见[首阶段运行说明](../../claude-web-embedding.md)。本次不变更生产、不操作真实Claude，不宣称中文/附件/自动失效识别或真实Ubuntu联调完成。
