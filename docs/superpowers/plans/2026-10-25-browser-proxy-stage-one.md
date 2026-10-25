# 本地浏览器代理：第一步执行计划

> 由当前会话按 executing-plans 执行，逐项完成并验证；不另建聊天或委派任务。用户已授权按[选定方案](../specs/2026-10-25-local-browser-remote-egress-design.md)开始实现，并要求每一步验证通过后再继续。

**Goal:** 实现并验证服务端受限网页TCP通道，为本地内嵌浏览器提供网络基础。本步骤不接官网、不部署、不替换现有Chat画面实现。

**Architecture:** 复用现有CC的TLS监听，新增`/cc-browser/v2/status`与`/cc-browser/v2/connect`。每个WebSocket对应一个HTTPS目标连接，首帧`{type:'connect',token,host,port:443}`认证；服务端检查精确域名白名单及远端DNS解析的所有地址，固定已验证的公共IP拨号，返回`{type:'ready'}`后只转发二进制。默认不配置白名单即关闭；强制审核、维护、关闭门禁继续生效。

**Tech Stack:** Node24、ws、node:net、node:dns，沿用现有服务认证/限流方式。新增生产依赖为零。

## 1. 基线与测试先行

- [x] 在现有专用codex/claude-web分支确认干净状态；旧画面/受管部署18项基线通过。
- [x] 新增`apps/server/test/browser-proxy.test.ts`，先运行看到新模块缺失而失败。
- [x] 测试具体行为：允许常见公共IPv4/IPv6，拒绝内网/映射/保留地址；精确域名及443端口；认证/门禁不触发DNS；混合DNS答案拒绝；连接关闭时销毁目标；二进制往返；DNS等待期间超时、断开或维护后不再拨号；官网TLS保持端到端（仅用本地自有测试证书/服务）。

运行：`node --test apps/server/test/browser-proxy.test.ts`，预期先因缺少`browser-proxy.ts`失败，随后各项通过。所有拨号目标由测试依赖注入映射到本机自有服务，生产默认解析/拨号不具备此映射。

## 2. 受限服务模块

- [x] 新增`apps/server/src/browser-proxy-target.ts`，导出`browserProxyHost`、`publicBrowserAddress`和`resolveBrowserTarget`。域名仅接受ASCII正常标签且不接受IP字面量、通配符、URL、尾点或用户凭据；IPv6仅允许公共单播范围并排除转换/文档范围。验证每次DNS的所有结果，拨号使用验证过的地址，不再交给系统重新解析域名。
- [x] 新增`apps/server/src/browser-proxy.ts`，导出`createBrowserProxy`，提供handle/upgrade/busy/close接口。未认证5秒期限，认证后DNS/拨号单独15秒期限，最多64个连接、单帧256KiB、Origin拒绝、心跳和反压、关闭期间拒绝升级；不在日志或错误中输出凭据或网站内容。期限可在测试构造时缩短，环境变量不接受绕过策略的测试依赖。
- [x] 验证失败先定位原因，不放宽目标策略或审核门禁来使测试通过。

协议：目标连接建立成功且准入仍有效时发送`ready`；此前的额外数据、此后的文本帧均拒绝。授权/白名单/地址失败不尝试替代目标，不接受HTTP明文目标，不解密网站TLS。

## 3. 完整服务接线

- [x] 修改`apps/server/src/server.ts`：增加`browserProxyHosts?: string[]`；新模块在旧`/cc-browser/`处理之前路由，参与维护busy和close；沿用当前token和共享Throttle；与旧通道同样拒绝强制审核/维护。
- [x] 修改`apps/server/src/config.ts`：读取`PROXY_BROWSER_PROXY_HOSTS`精确逗号分隔域名列表，空配置保持关闭；无新公网端口。
- [x] 新增完整createProxyServer及环境配置回归：新路径在真实TLS服务上可见，旧通道不吞掉v2请求；默认关闭；审核配置存在时，即使白名单有效仍返回moderation-required且不拨号；维护关闭不访问目标。

运行：`node --test apps/server/test/browser-proxy.test.ts apps/server/test/browser-service.test.ts apps/server/test/config.test.ts apps/server/test/native-deployment.test.ts`。之后运行TypeScript、生产构建和完整Node回归；出现新故障时调查并修复，再扩大验证。

## 4. 验收记录与下阶段

- [x] 更新运行说明，明确本步骤只完成服务端基础；浏览器尚未改为本地视图，实际Ubuntu出口和官网功能均未验证。
- [x] 核对diff、文档链接、秘密检查，提交本地可审查结果；不推送、不发布、不部署。

下一步在本步骤验证通过后实现本机有随机凭据的HTTP CONNECT代理，再接入隔离Electron浏览器session；每一步各自验证无本地回退。最后再单独验证账号区隐藏：用户已要求只隐藏左下角设置/账号区，允许本地显示样式适配，但不能将其当作权限限制，也不修改官网业务请求。未取得当前网页结构并验证前不编造选择器或宣称隐藏已完成。

验证记录：新增15项测试通过；全量Node579项中544通过、35按现有条件跳过、0失败；TypeScript和生产构建通过（保留既有主入口大于500kB提示）。独立复核无剩余P1/P2；额外以自有服务验证32MiB响应在接收暂停500毫秒并遇到目标EOF后完整到达。首次站点TLS测试误用自签夹具配CA，改为现有CA签发夹具并保持TLS验证；完整接线的测试先验证缺失v2路径/配置失败，测试回调中的异常传播随后修正，遗留测试进程已清理。域名复核发现Unicode大小写转换和末尾换行可混淆ASCII校验，先补失败回归，再明确限制原始ASCII字符；完整复跑通过。未访问Claude或远端Ubuntu。
