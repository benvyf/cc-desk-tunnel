# 代码定位与 PDF 文字层实施计划

> 用户已确认先实施这两项功能。使用 executing-plans / subagent-driven-development 分项执行，测试使用假服务，不请求真实模型。

**目标：** 在现有预览内提供代码行号、按标签保存换行偏好、指定行导航，以及 PDF/Office 文字选择和复制。

**架构：** 保留原客户端预览 IPC、远端模型 SDK 与执行通道。代码由独立的只读组件展示，导航是客户端一次性意图，不进入模型协议。PDF 复用包内 PDF.js 的核心 TextLayer，与当前页画布共同缩放和取消；Office 使用既有转换 PDF。TextLayerBuilder 内部使用模块级 document/window，不适合本项目弹出窗口的归属，故只接入其已有核心排版和 Unicode 规范化能力，复制监听限定在所属文字层。

**技术：** React、TypeScript、PDF.js 5.4.624、现有 ui.tsx / 主题变量、Node 24、Playwright / Electron。

## 选择与边界

- 选用现有代码预览的局部增强，不引入编辑器、写文件或新依赖。行号默认显示；行号不进入鼠标选区、复制或辅助技术的正文。
- 默认保持长行横向滚动，换行开关按连接/区域/工作区/会话/tab 保存；旧布局默认不换行。文本及 Markdown 源码使用同一组件；Markdown 排版与 HTML 页面保持现有渲染。
- 文件链接已有 line/column 信息要传至侧栏。重复点击同一文件的同一行也能再次定位；导航切到 Markdown/HTML 源码，真正的网页仍需明确加载确认。恢复布局只恢复阅读位置，不重放旧导航。超出行数裁到有效末行；非法输入显示校验或不触发，不产生读取请求。
- 代码保持原文复制（包括换行和末尾换行），只解析一次文本行；长文档验证 DOM/CPU 开销，必要时只在屏幕附近生成行号，而不引入通用编辑器体系。导航高亮不抢输入焦点。
- PDF 只加载当前页文字；按原画布的有效 viewport（包括像素上限裁剪、旋转、字号/视口变化）叠加透明文字层，不出现重复黑字。复制为纯文本，禁止为选区增加引用工具、自动附件或消息。
- 扫描件无文字时提供低干扰说明，不做 OCR。文字解析失败保留画布并显示说明，不把文件判为不可打开。翻页/缩放/刷新/卸载取消文字任务并释放选区与监听。
- 无新增模型 SDK、API 密钥、远端端点、预览 IPC 或自动内容回传；本机文件读取、Office 转换、网页确认策略和原 SSH 能力不扩大。

## 任务

- [x] 1. 基线与失败回归：代码行号/原文复制/换行持久化/手动和链接定位；PDF 选择复制/缩放对齐/翻页取消。先观察缺失功能导致的失败。
- [x] 2. 代码状态：`previewLayout.ts` 保存 wrap，导航使用只在内存的 request 标识；`preview.ts` 转发行号且明确去重、恢复与边界；纯单测覆盖旧布局/恶意字段/关闭和移动。
- [x] 3. 代码视图：新 `PreviewCode.tsx` / 局部 CSS，接入 `PreviewContent.tsx`；复用既有阅读状态、按钮与工具栏。支持跳转行输入、Enter、有效行高亮、复制完整原文和本机选区。
- [x] 4. PDF：修改 `PreviewPdf.tsx`，新局部文字层 CSS；复用官方核心 TextLayer 的布局与 Unicode 规范化，复制仅处理所属文档的明确选区，保持 canvas 单页及上限。真实文字 PDF、旋转/页面单位、无文字 PDF、Office 转换结果验证。
- [x] 5. 集成与性能：代码 4MiB 上限内大文件、10000+ 行、横向/换行/快速重复导航，主对话流式更新不重读、不重建预览；PDF 当前页与反复开关监听/任务有界。
- [x] 6. 复核：浅/深色、390/1024/1440、14/20px、主侧会话及浮窗，检查真实鼠标选区/复制和遮挡；模型边界测试不得出现新增控制帧或 message.send。
- [x] 7. 运行适配单测、UI、真实 Electron/Office、类型/构建/格式/索引检查。记录既有发布历史断言，禁止伪造发布记录。

## 验收与验证

代码：行号对齐换行；复制原文不含行号；换行/阅读位置在切标签、移动、正常重启后恢复；路径 `a.ts:12` / `#L12` 在侧栏定位第12行且重复点击仍有效。无权限/HTML 未激活页面保持既有提示，不为导航自动加载网页。

PDF：鼠标拖选、Ctrl+C/复制事件得到正确文字；125%/50%/300%、视口变化及旋转仍对齐；当前页替换后无旧文字；扫描件说明真实无 OCR；文字失败不隐藏成功画布。Office 沿用一次正常转换，不因选区重复转换；复制不自动发送。

```powershell
node --test apps/desktop/test-main/preview-layout.test.ts apps/desktop/test-main/preview-view-state.test.ts apps/desktop/test-main/preview-persistence.test.ts
npm run typecheck
npm run build
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npx playwright test apps/desktop/test/preview-code.spec.ts apps/desktop/test/preview-pdf-text.spec.ts apps/desktop/test/preview-reading-state.spec.ts apps/desktop/test/preview-workspace.spec.ts apps/desktop/test/preview-performance.spec.ts apps/desktop/test/quoted-conversations.spec.ts --reporter=line
$env:CC_PREVIEW_ELECTRON_TEST = '1'
node --test apps/desktop/test-main/preview-electron.test.mjs
Remove-Item Env:CC_PREVIEW_ELECTRON_TEST
npm run format:check
npm test
npm run check
git diff --check
```

完成后记录实际改动、失败回归、资源计数、视觉证据与未覆盖环境。代码交付不等同安装包发布，不自动推送主分支或部署。

实施与验收结果见[专项复核记录](../../PREVIEW-CODE-PDF-TEXT-REVIEW-2026-10-31.md)：组合 157 项通过；随后同帧导航修正后的代码专项 14 项通过，PDF 新增 15 项通过；真实 Electron 1 项通过。全量单测仅保留既有发布历史断言，相关环境失败和独立复测均明确记录。
