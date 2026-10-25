# 本地网页视图与客户端接线 Implementation Plan

> 执行方式：沿用 executing-plans，按下列顺序实施、验证和复核。

**Goal:** 将已验证的v2代理接到独立Electron网页session，再替换Chat旧画面视图；先只用自有站点测试，不部署或访问Claude。

**Architecture:** 新增browser-view.cjs负责session/WebContentsView、代理认证、网络方案和权限限制、边界、下载与关闭。沿用browser-session.cjs的generation机制，改为schema2并在main中创建视图；bridge提供v2状态及主进程代理。renderer仅获取状态并上报可视区域，不接收URL、代理或服务凭据。官网入口固定https://claude.ai/，无自定义目标IPC。

**Tech Stack:** Electron44、Node24、React、现有ws；无新生产依赖。

- [x] 新增test-electron/browser-view.test.mjs及fixtures/browser-view.cjs：先验证缺少模块失败；自有HTTPS服务通过v2通道，域名仅测试进程内映射回环，站点测试证书仅由测试夹具对精确证书信任。生产模块不添加证书例外。真实Electron需验证隔离（无desktop/require/preload）、代理配置、中文原生输入、Cookie重开、跳转/新窗口、下载、WebSocket、service worker、断线不直连。测试不得访问官网。
- [x] 新增browser-view.cjs：先setProxy({mode:'fixed_servers',proxyRules,proxyBypassRules:'<-loopback>'})及closeAllConnections再创建视图/加载。固定session持久分区；网站无preload、sandbox/contextIsolation且无Node；仅同一session所属contents的精确本机代理认证可获得随机凭据。webRequest只准HTTPS/WSS443及本地data/blob资源；导航只准HTTPS443；拒绝外部协议、设备/媒体权限、webview；WebRTC禁非代理UDP；启动禁QUIC、DNS预取。关闭保留拒绝请求门禁，停止视图并关闭session连接及代理，不重置DIRECT。
- [x] 实现下载save dialog，下载仅走所属session，不打开文件；关闭取消未完成下载。新窗口初版在相同视图打开安全URL，拒绝系统浏览器移交；第三方登录弹窗兼容性单独保留限制说明。
- [x] 更新browser-session.cjs及其失败回归：schema2、等待状态/代理/视图过程控制连接变化应关闭迟到资源。view factory为main注入；renderer结果只含enabled/reason。mode/bounds不可改变代理或URL。
- [x] 更新proxy-bridge.mjs导入本机代理、v2状态和openBrowser；main注册视图factory、边界和状态通知；preload及desktop.d.ts增加bounds/state，仍仅自有file renderer可用。封装打包检查确认代理确实进入bundle。
- [x] 替换ClaudeWebPage.tsx旧RFB逻辑为状态+ResizeObserver边界，保留Chat/Coding草稿、登录维护提示、手动打开/重连；不自动登录或发送消息。维护期间关闭视图；管理员在客户端人工重新登录。修改相关UI测试，旧RFB测试保留为历史独立测试，不作为新方案验收。
- [x] 运行真实Electron离线验收、UI针对性测试、全量Node、类型检查、生产构建和桌面暂存打包检查。独立复核后提交本地结果。账号区隐藏需要实际官网结构，当前不编造选择器；实际Ubuntu出口和管理员网页登录留待远端联调，不以离线结果替代。

命令：`node --test apps/desktop/test-electron/browser-view.test.mjs`；`node --test apps/desktop/test-main/browser-session.test.mjs`；`npm run typecheck`；`npm run build`；`node node_modules/@playwright/test/cli.js test apps/desktop/test/claude-web.spec.ts`；`npm test`。

生产强制审核节点仍拒绝Chat。不更改现有审核、SSH AllowTcpForwarding、远端profile或生产容器。即使所有本地测试通过，也不承诺网站全部功能或账号不会受限制。
