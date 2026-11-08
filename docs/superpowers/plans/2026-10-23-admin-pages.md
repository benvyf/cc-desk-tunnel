# CC 管理中心独立功能页 Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan in this session. 用户已批准实现并上线，不重复申请同一许可。

**Goal:** 顶部统一导航与三个有独立地址的互斥功能页。

**Architecture:** Node明确路径返回同一管理壳；navigation.js集中处理history/显示/当前页，app.js负责登录和当前页加载，moderation.js专注审核。

**Tech Stack:** 现有 Node24、原生浏览器模块、CSS、Playwright。

## 1. 先验证缺失行为

- [x] 在 `apps/update-service/test/http.test.ts` 增加三个直接页面 GET/HEAD、未知页面404和禁止POST测试；运行Node24该文件，确认当前直接页面404。
- [x] 在 `apps/update-service/test/ui.test.ts` 调整为账号页默认、进入更新页操作安装包；检查三个互斥视图、顶部导航、独立地址、前后退、刷新重登及网络请求隔离；确认当前无导航账号入口而失败。

## 2. 实现功能页

- [x] 修改 `apps/update-service/src/http.ts`：将明确的三个页面映射到现有index资源，加入navigation.js资源。其他路径保持404。
- [x] 修改 `apps/update-service/web/index.html`：统一nav提前，三个链接分别指向对应地址；监控区增加monitor-panel，所有功能初始hidden，页头统一。
- [x] 新建 `apps/update-service/web/navigation.js`：真实链接、pushState/popstate、current页面及互斥hidden、aria-current和标题。
- [x] 修改 `apps/update-service/web/app.js`：login/load按current分派；移除refresh连带读取monitor；仅账号页轮询；操作中排队最新导航请求，logout清理导航显示。
- [x] 修改 `apps/update-service/web/moderation.js`：去掉内置导航和show，导出refresh供统一导航调用；切换不主动清草稿。
- [x] 修改 `apps/update-service/web/style.css` 的顶栏、链接选中态和移动适配；`scripts/package-update-service.mjs`纳入新模块。

## 3. 验证与上线

- [x] Node24运行HTTP/监控兼容测试及显式开启CC_UPDATE_UI_TEST的真实浏览器测试；检查截图和网络请求。
- [x] 类型、格式、索引秘密/链接和diff检查通过；提交并打包干净源码，解包hash/API smoke。
- [x] 独立复核路由/登录/页面竞态；保留现有生产配置和数据做一致备份后上线，验证正式HTTPS三个页面及私有接口权限、数据库/密码/审核节点身份不变。
- [x] 更新实际部署记录并给出正式入口；保持六台Ubuntu等待接入的真实状态，不发Claude/JEV测试请求。
