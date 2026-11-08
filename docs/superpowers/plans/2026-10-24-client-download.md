# 定制完整客户端与下载入口 Implementation Plan

**Goal:** 构建具有既有 VPS 更新能力的最新完整 Windows 客户端，并在管理中心提供清楚、可验证的下载入口。

**Architecture:** 合并 VPS 保存的 Build 2 Git 源码与当前生产分支，沿用原签名发布流程。下载区使用现有认证 `/status` 数据和固定同源制品路径，不增加账号查询。

**Tech Stack:** Node 24、Electron、NSIS、原生 JavaScript 管理页面、Playwright、现有 VPS 更新服务。

## 1. 恢复发布源码

- [x] 将已验证来源的 `codex/recovered-client-build-2` 合并到当前干净功能分支；处理文档／HTTP 差异时保留当前管理中心、监控、审核和密码实现。
- [x] 检查 `deploy/managed-client.json` 的生产公钥与线上通道一致，并将构建号提高到未占用的下一编号。
- [x] 运行 `node --test apps/desktop/test-main/managed-client.test.mjs` 和相关更新契约测试，验证新旧实现已正确集成。

## 2. 下载区

- [x] 在现有 `apps/update-service/test/ui.test.ts` 真实浏览器发布流程中补充断言：已发布 pilot 的下载 URL、版本与构建号、复制链接；empty、过期和退出时不提供下载。先运行并确认缺少下载区导致失败。
- [x] 修改 `apps/update-service/web/index.html`、`app.js`、`style.css`，在现有客户端更新页显示下载卡片。卡片只来自 `status.channels`，不使用 candidates。下载 URL 固定为 `/cc-updates/v1/artifacts/{build}/win32-x64/{filename}`，路径参数必须符合原发布契约。
- [x] 卡片显示 Windows x64 完整安装包、试点／正式通道、版本、Build、大小、说明、配套协议和 SHA256；复制操作仅复制公开制品链接。
- [x] 运行 `CC_UPDATE_UI_TEST=1 node --test apps/update-service/test/*.test.ts`；移动端截图与页面宽度检查应通过。

## 3. 构建与审查

- [x] 运行类型、格式、源码与相关回归检查，独立审查合并及下载边界；修复影响发布的问题。
- [x] 提交通过验证的源码以固定构建身份；执行 `node scripts/package-windows.mjs`，使用其隔离离线包内启动测试。
- [x] 检查完整安装包的内嵌身份、运行组件、大小和 SHA256，保存脱敏构建证据；不安装到用户当前路径。

## 4. VPS 上线及发布

- [x] 打包管理服务，按现有部署脚本模式校验当前 runtime manifest，备份并替换独立管理服务，保留配置与业务数据。
- [x] 按当前签名身份和递增 revision 创建 pilot 签名候选，通过现有 API 上传、校验及激活新安装包；stable 保持原状态。
- [x] 下载公网完整安装包并验证 SHA256，真实浏览器验证下载入口、复制链接、功能导航和移动布局，不触发 Claude／JEV。
- [x] 文档记录实际构建提交、Build、校验值、下载与管理入口、备份回滚和未执行本机安装的边界。
