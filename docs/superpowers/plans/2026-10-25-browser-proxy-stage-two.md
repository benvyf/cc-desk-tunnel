# 本地浏览器代理：第二步执行计划

**Goal:** 在第一步已验证的服务端基础上，实现本机认证HTTP CONNECT代理及WSS桥接；仍不加载官网或部署服务。

**Architecture:** 本机随机回环端口，只接受带每次随机Basic凭据的CONNECT目标域名:443。主进程通过既有服务证书验证工具连接固定v2通道，证书通过后发送服务认证首帧，收到ready后才响应本机200并转发原始字节。无目标本地解析或直连代码、无重定向、无自动重试。关闭或连接超时销毁全部socket及尚未完成的服务连接。

**Tech Stack:** Electron主进程侧ESM、Node24、ws，沿用secure-service.mjs。无新生产依赖。

- [x] 在apps/desktop/test-main/browser-network-proxy.test.mjs先写失败回归：缺少新模块；随机本机凭据、无凭据407且零远端拨号；非CONNECT/非法目标拒绝；可信服务及自有站点TLS完整往返；错误pin与未信任CA零凭据；重定向拒绝；远端关闭后本机断开；半开连接与待认证关闭；首帧/心跳超时。
- [x] 新增apps/desktop/electron/browser-network-proxy.mjs，导出browserProxyAddress、openBrowserNetworkProxy。返回proxyRules、proxyBypassRules、username/password及close，仅供主进程后续使用，不写磁盘或交给官网。固定服务器代理配置不包含DIRECT，移除Chromium隐式回环绕过。
- [x] 运行新增回归和第一步代理回归，修复后再运行类型检查；打包桥接检查在模块接入入口后执行；网站测试仅用自有证书和进程内回环映射，不关闭站点证书验证。
- [x] 独立复核生命周期和敏感数据边界，再运行必要回归，提交本地结果并更新docs/claude-web-proxy.md。

下一步才将该代理连接到单独持久Electron session/WebContentsView及Chat界面；本步骤不宣称Chromium所有路径已被约束，也不宣称Ubuntu实际出口已验证。前端、profile、账号区隐藏以及生产审核准入仍未完成。

测试命令：`node --test apps/desktop/test-main/browser-network-proxy.test.mjs apps/server/test/browser-proxy.test.ts`；`node node_modules/typescript/bin/tsc --noEmit`。

