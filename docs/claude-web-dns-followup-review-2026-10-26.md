# DNS 修复提交的再次审查

2026-10-26 香港时间，审查基线为 `5f697a2`。范围包括网页 DNS 边界、受管更新与系统代理辅助进程、Coding 兼容、取消回收和包态入口。本轮只使用自有测试服务，没有访问 Claude、处理账号或 Cookie、部署生产或发布安装器。

## 发现并修复的问题

发现一项 P2：Coding 的控制连接和 SSH 承载连接调用 `connectService()` 时，没有传递连接控制器的取消信号。新增的系统代理/PAC 辅助进程因此无法感知 Coding 关闭；PAC 挂起时，关闭约 217ms 后进程仍在运行，直到约 15 秒期限才退出，可能占用辅助进程并发位置并拖慢重连。

现在在构造控制 WebSocket 前创建连接控制器，两处服务拨号都传入同一个 `controller.signal`。既有关闭流程可取消实际 PAC 求值、终止辅助进程并回收临时 profile；网页 DNS guard、代理规则和 TLS 校验没有改动。

新增真实回归 `closing the Coding bridge terminates its actual stalled PAC helper`：通过正式 Coding bridge 和实际 Electron 辅助进程进入挂起 PAC，再关闭 bridge，要求 profile 及时归零、目标 HTTP 请求为零。旧代码先失败，修复后通过；最终全套运行该项约 217ms。独立诊断复核显示关闭后约 208ms 信号已取消、辅助进程退出、profile 清空，约 209ms 时已观察到的 GPU 和 NetworkService 子进程也全部退出。

## 验证与独立复核

- 完整桌面主进程测试共 250 项：219 通过、31 按既有条件跳过、0 失败；包含辅助进程 16 项测试和真实 Coding 连接回归。
- Chat/Coding 界面测试 4/4 通过，包含真实 Electron 打开自有网页、切换及登录维护流程；使用本机 Edge 作为 Playwright 浏览器。
- TypeScript 类型检查和 `stageDesktop` 构建通过，保留既有 bundle 大小提示。暂存的主入口及两个辅助 CJS 与源码逐字一致，bridge bundle 包含取消信号接线。
- 本轮补修前的原生主入口 dry-run 通过：新的随机测试标签没有本机 DNS transaction，UDP_BYTES_SENT 为零，代理断开后阻断和视图关闭通过。本轮补修仅改变 Coding 取消接线，最终界面及主进程回归覆盖该代码。
- Python 抓包读取器 9/9 通过；重新分析此前最终抓包，结论仍为 REVIEW_REQUIRED。
- 两位独立只读 reviewer 分别复核 DNS/辅助进程能力边界与取消生命周期；补修后未发现其余可确认的 P1/P2。

另外使用复制的 Electron runtime、正式三个 CJS 和真实 `app.asar` 验证包态辅助入口，确认 `app.isPackaged=true`：不匹配包内固定更新源时拒绝；匹配自有 HTTPS 源但证书不受信时，仍拒绝 TLS，服务端零 HTTP 请求；两个辅助角色无 IPC 启动均以退出码 1 拒绝；临时 profile 全部回收。没有安装 CA 或降低 TLS 校验。这不是安装器或包态 UI 验收。

私有证据留在忽略目录：`.local/dns-review-round2-{desktop,ui,stage,regression}.log`、`.local/review-helper-bridge-close.mjs`、`.local/cc-native-network-7d7674b3/dry-run/`、`.local/packaged-dns-helper-RDKnxQ/report.json`。包态首次尝试保留在 `.local/packaged-dns-helper-aQ7B6X/`：复制 runtime 仍叫 electron.exe 时被 Electron 判断为开发态；将复制可执行文件改为产品名后完成上述真实包态验证。未修改安装的 Electron runtime 或 node_modules。

## 仍保留的验收边界

此前抓包中 UDP 阳性标记缺失、接口丢包 225、没有公网 IPv6 端到端目标等限制仍在，不能据此声明所有流量绝对零泄漏。没有新增系统强制网络隔离，也没有完成真实 Ubuntu 双侧联调、生产审核准入、真实官网登录或安装器验收。128 项排队上限的精确边界未单独实测；已有并发、排队取消和挂起取消回归不能替代该边界测试。

本轮可复现的 DNS 缺口和新增发现的 Coding 取消缺陷已有对应验证；其余结论仅适用于上述审查和测试范围。原有网络证据与限制见 [DNS 修复验证](claude-web-dns-fix-validation-2026-10-26.md)。
