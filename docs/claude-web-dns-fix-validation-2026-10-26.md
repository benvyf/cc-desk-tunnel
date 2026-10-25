# 已知 DNS 缺口修复与本机复测

2026-10-26 香港时间，基线 7b84be3。已修复原生启动下可复现的 RTC 和 DNS 预取本机解析路径。修复后的指定探测通过本机复测；这不是所有网络行为、真实 Ubuntu 链路或 Claude 官网的完整验收。未访问 Claude、迁移 Cookie、部署生产服务或发布安装器。

## 修复

主进程在 Chromium 启动前设置 host-resolver-rules：MAP * ~NOTFOUND, EXCLUDE 127.0.0.1。网页 session 仍使用固定的数字回环代理；CONNECT 中的站点域名交给 Ubuntu 解析。RTC、预取等不能经代理完成的域名解析直接失败。保留既有 QUIC、WebRTC、权限、站点 TLS、服务端域名白名单和断线关闭门禁。

全局 Chromium DNS 边界也影响原有受管更新。更新 GET 改由无窗口的独立 Electron 辅助进程执行，保留 Chromium 系统代理和 CA 行为；只接受固定更新源、GET、有限请求头，不使用站点 profile 或 Cookie、不监听端口、不自动跟随重定向。包态从内嵌 managed-build.json 读取更新源；网页 renderer 没有调用该辅助进程的接口。

收尾复查还复现了系统代理 PAC 的兼容问题：相同离线 PAC 中，dnsResolve("localhost") 在无 guard 时成功、有 guard 时失败，会导致 Coding 选择不同的代理。因此主进程两处服务代理解析也改用该辅助进程的独立只解析模式。该模式只接受无凭据的 HTTPS/WSS 服务 URL，在 15 秒内完成系统代理/PAC 求值，不发起目标 HTTP 请求；不能执行更新 GET。网页 renderer 无法调用。辅助进程的系统 DNS 用于更新或已有 CC 服务 PAC，网页域名仍不能进入此路径。Node 控制连接和 Coding 的目标连接、认证及证书检查保持原实现。

只解析模式最多同时运行 2 个辅助进程、最多排队 128 个任务，拒绝超额或超时请求。调用方取消信号传到实际 helper，排队取消直接移除；进程关闭并清理 profile 后才释放运行位置，避免连续失败产生进程重叠。新增真实回归挂起 PAC 后验证并发上限、取消排队项后剩余任务继续启动、全部取消回收，以及实际浏览器代理关闭后 helper/profile 归零。

辅助进程通过继承 IPC 按需传送最多 64KiB 的一块数据，取消时终止，正常结束后清理临时 profile。实测发现并修复两个异常：Windows 在进程退出后短暂锁住 Chromium 数据库，删除增加最多 1.5 秒的有限重试；父进程收到数据后可能先于发送回调请求下一块，现将读取保护在发布数据前释放，避免误报协议错误。

## 回归的红绿证据

- .local/cc-native-network-d3829410/dry-run：未修复时，新的原生 DNS 回归失败，记录 5 条带随机标记的 RTC/预取 DNS transaction。
- .local/cc-native-network-ead0246d/dry-run 和补齐 PAC 兼容后的 .local/cc-native-network-699833ad/dry-run：通过正式 main.cjs、preload/IPC 和真实 WebContentsView；带随机标记的本机 DNS transaction 为空，全部 UDP_BYTES_SENT 为 0。自有 HTTPS 正常，停止代理后请求被阻断，网页关闭正常。
- 更新快读回归在测试 fixture 中故意延迟 chunk 的发送回调：旧读取保护顺序确定失败为 Update helper protocol refused；修复顺序后完整读取 8MiB。取消/并发回归在未限制时先复现 3 个 helper，与期望最多 2 个不符，修复后通过。辅助进程最终 15 项测试通过，时序注入、PAC 挂起和自有站点证书信任仅存在于测试入口。

## 本机系统抓包

第一次修复抓包保留在 .local/cc-native-network-4d2e1122/，DNS 阳性可见、网页探测无查询，接口 drop 为 16。补齐 PAC 和取消兼容后，用最终版本再次抓包，私有证据目录为 .local/cc-native-network-699833ad/：UTC 18:27:34.085 至 18:28:19.789，覆盖阳性对照及 UTC 18:28:05.404 至 18:28:18.734 的浏览器运行。以下观察以最终这次为准。

管理员只运行 PktMon 助手，浏览器由普通权限 Codex 启动。没有增删抓包筛选器，停止后确认 PktMon 未运行，文件仅保存在本机忽略目录。原生 wrapper 将 app 路径设为实际 apps/desktop，使派生 helper 使用正式入口，而不是诊断脚本目录。

DNS 阳性对照改用 Windows Resolve-DnsName，对自有域名下的新随机标签发起 A 查询。DNS Client ETW 记录了该标签；PCAP 中也有 1 个发往 fe80::1:53 的出站查询 observation，按 DNS query 标志、问题数和完整唯一首标签确认，未将响应或网页探测混入控制。该数为采集 observation，不代表实际请求总数。

同一窗口中，网页 RTC、预取及站点测试标签没有出现在 DNS Client ETW 或出站 DNS 探测匹配中。NetLog 中测试标签的 DNS transaction 为空、UDP_BYTES_SENT 为 0，TCP 尝试仅指向 127.0.0.1。原生功能检查通过，包含代理断开后的阻断。

本轮限制：

- 独立发向自有 VPS 3478 的 UDP 阳性标记未被捕获，不能据此验证所有 UDP 采集路径；DNS 的阳性证据来自另一个独立的 DNS 控制。
- 最终接口丢包计数为 225、OS 丢包计数为 0；PktMon 停止时的“无事件丢失”不能替代接口丢包统计。因此不作全网络零泄漏认证。
- NetLog 中仍能看到 IPv6 路由探测 socket 建立，但没有字节发送记录，抓包没有匹配其精确元组；不能推广到所有 IPv6 情形。
- 自有 VPS 没有可用公网 IPv6 目标，未做公网 IPv6 端到端验收。
- 抓包中其他访问自有 VPS 的连接没有进程归属，不能仅按 IP 归因给内嵌网页。
- 此处使用自有离线服务；不能与此前 Ubuntu 出口实验拼接为同一次正式端到端验收。读取器保留 REVIEW_REQUIRED，不自动给出完整安全通过。

## 其他验证

最终完整桌面 Node 回归共 249 项：218 通过、31 按既有平台条件跳过、0 失败，包含 Coding 实际连接、系统代理、受管更新和辅助进程 15 项测试。真实 Electron 网页隔离测试 1/1 和 Chat/Coding UI 4/4 通过。UI 首次运行因缺省 Playwright 浏览器未安装导致两项启动失败，改用本机 Edge 后全部通过，没有改动产品代码绕过失败。

一次并行回归中，截断响应测试在取得响应头前遇到 ERR_NO_BUFFER_SPACE，单项复测未重现；未据此认定产品根因或加入静默重试。自有测试服务原本用 30ms 定时断开，现改为测试收到响应头后再明确截断，去除与进程调度的竞争，继续要求真实不完整响应被拒绝。该次失败日志留在本机私有目录。

类型检查、修改文件格式检查、git diff --check、Python 抓包读取器 9/9 通过。stageDesktop 生产前端/bridge 构建成功，新增两个 CJS 文件与源文件逐字一致；暂存应用的辅助入口无 IPC 时按预期退出。包态固定更新源由测试 fixture 模拟 app.isPackaged 验证，尚未运行真正安装器。保留既有大于 500kB 的构建提示。

独立只读审查未发现确定的重要缺陷，并复核了更新进程隔离、系统代理/CA兼容和数据发送时序；系统证据结论按上述范围限定。

下一阶段仍需分别处理 Ubuntu 正式链路双侧复测、生产审核准入、真实官网登录及安装器运行验收。本轮没有授权或实施这些生产变更。历史失败证据见 [修复前本机网络验证](claude-web-native-network-validation-2026-10-26.md)。
