# 本机预览工作区

此功能参考 DeepSeek Harness 的右侧 Sidebar 和本地 Office 引擎，在 CC SPACE 原有预览侧栏上实现。此分支为客户端源码交付，尚未生成或发布新的正式安装包；线上 Build 24 不包含这些改动。

## 使用

- 在本机项目会话点击标题栏的预览入口，或点击聊天、原生终端里的本机文件链接。预览头部可打开文件、切换工作区目录、打开用户指定的本机网站、放大和收起。
- 工作区目录按展开加载，目录优先排序。支持鼠标、上下方向键、Home/End 导航、左右方向键展开/折叠、刷新目录和定位当前文件。文件只读展示，不增加写入或删除能力。隐藏文件、凭据目录、网络共享和越界符号链接不列出；`.local` 生成目录可用。
- 当前文件及展开目录会自动刷新。监听支持编辑器原子保存、文件删除/重建和目录替换；无关文件的修改不会重读当前文档。切换到未显示的文件时读取最新内容。手动刷新继续保留。
- 标签、当前选择、目录栏开关、宽度、分栏、浮窗位置及尺寸按连接工作区、会话和主/终端区域分别保存在本机。只保存元数据，不保存正文。恢复的网站、HTML（包括指向 HTML 的其他后缀别名）必须点击“加载此预览”后才加载页面。
- 每个工作区最多四个窗格、64 个标签。点击“分栏”拆出当前标签；拖动标签可重排或移动到另一窗格，也可用“移动”按钮。点击“浮动”后可以拖动标题、拖动右下角调整大小，再点击“停靠”收回。浮窗保持在所属窗口内；窗口缩小时重新限制位置。浮窗尺寸支持方向键调整。窄窗口上下排列，放大后的宽窗口左右排列。
- HTML 支持页面/源码，Markdown 支持排版/源码，图片支持缩放，代码与 UTF-8 文本使用现有代码块。PDF 使用内置本机 PDF.js 查看器，提供页码和缩放。Office 使用随客户端打包的本地 LibreOffice Kit 转换后在同一查看器展示，支持 DOC/DOCX、XLS/XLSX、PPT/PPTX 及 ODT/ODS/ODP；不依赖用户安装 Microsoft Office，不调用在线预览服务。缺失字体使用本机替代字体并提示名称。

## 客户端与模型的边界

目录列举、文件监听、文档读取、Office 转换、PDF 绘制、布局保存及网页访问由客户端完成。没有新增模型工具、服务端协议、模型调用、自动附件、DOM/截图读取接口或预览内容回传。网页没有 preload、Node 集成或 `window.desktop`。新增 IPC 只供应用自己的受信任页面使用。

HTML 静态资源通过随机本机域名提供，读取限制在选定项目内，解析后再次检查边界。静态预览的跨源请求、其他本机服务、内网/公网地址、Worker、frame、弹出窗口、下载与表单提交均被限制。HTML 不能自动跳转出文件预览来打开本机网站。Markdown 的远程图片保留为用户可点击链接，不自动联网。

本机网站仍由用户明确打开，仅接受 localhost、127.0.0.1、[::1] 的 HTTP(S) 地址，不启动开发服务或新增端口转发。网页网络资源限于该标签经用户明确输入的来源；同主机端口的开发 WebSocket 可用。关闭/切换连接会释放旧视图；仅切换标签时保留网站自身导航状态。窗口遮挡及拖动时隐藏相应原生网页层。

Office 引擎使用私有配置，禁用宏、外部链接更新和外部图片读取，设置拒绝所有主机的 allowlist。这是引擎应用策略，不是对现有客户端执行通道的操作系统网络沙箱声明。本次没有修改 Claude Code 或现有执行通道。

## 限额与生命周期

文本 4 MiB，图片/PDF/Office 输入与转换后 PDF 各 20 MiB；目录最多 2000 条；每个渲染器最多 128 个订阅和原生目录监听。Office 串行转换、最多四个等待/运行请求，每次 60 秒期限。临时副本和输出在转换后清理，重载/退出取消待完成转换。失败显示错误并保留系统打开入口。

销毁/关闭标签、删除会话、切换工作区、渲染器重载和窗口退出都会清理对应资源。隐藏的网站可以保留自身开发服务连接，但其内容不进入模型协议。恢复布局不会自动恢复页面执行。

## 验证与打包

测试使用临时项目、专用客户端配置和模拟会话，不调用真实模型。专项覆盖文件树/监听恢复、布局过滤、HTML 别名加载确认、原生多窗格/浮窗、静态网络探针、真实 PDF 和六种 Office 格式、外部图片拒绝以及完整 ASAR 资源加载。UI 截图在本机 `.local/screenshots/preview-workspace/`，浅/深色和窄窗口沿用 CC SPACE 原有控件与样式。

```powershell
node --test apps/desktop/test-main/preview-workspace.test.mjs apps/desktop/test-main/preview-layout.test.ts apps/desktop/test-main/preview-files.test.mjs apps/desktop/test-main/preview-browser.test.mjs
$env:CC_OFFICE_INTEGRATION='1'
node --test apps/desktop/test-main/preview-office.test.mjs apps/desktop/test-main/preview-office-packaged.test.mjs
$env:CC_PREVIEW_ELECTRON_TEST='1'
node --test apps/desktop/test-main/preview-electron.test.mjs
Remove-Item Env:CC_OFFICE_INTEGRATION, Env:CC_PREVIEW_ELECTRON_TEST
npm run typecheck
npm run build
npx playwright test apps/desktop/test/preview-sidebar.spec.ts apps/desktop/test/preview-workspace.spec.ts
```

运行项目支持的 Node 24。Windows/macOS 打包保留目标平台的 LibreOffice Kit 原生引擎与 Koffi，Linux 使用其 WASM 引擎；整个 Office 运行时、Worker、完整性清单、源码与许可声明均保留在 `app.asar.unpacked/node_modules`。PDF.js 及其 Worker、字体、CMap、WASM 解码资源由 Vite 本地打包，不从 CDN 下载。

参考：[DeepSeek Harness Sidebar](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/sidebar-right.zh.md)、[Office 转 PDF](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/office-to-pdf.zh.md)。未引入 Harness 的插件/停靠运行时。
