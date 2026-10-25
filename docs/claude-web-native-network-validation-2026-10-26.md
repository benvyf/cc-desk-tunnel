# 原生启动与本机系统层网络验证

2026-10-26 香港时间，基线 15002d3。本轮只使用自有离线 HTTPS 页面、假数据及自有 VPS 测试目标，没有访问 Claude、迁移 Cookie、发布安装器或修改生产 CC。

## 验收结果：阻塞

当前实现不能通过“网页相关请求全部经远端出口”的验收。正式 main.cjs 启动路径下，WebRTC STUN/TURN 域名解析和 dns-prefetch 产生了本机 DNS 查询。已有固定 HTTP 代理、disable-quic、dns-prefetch-disable、disable_non_proxied_udp 设置不足以覆盖这两条解析路径。

本机 PktMon 抓到带本次唯一随机标记的 DNS 出站查询，目标为局域网 IPv6 DNS fe80::1:53；Windows DNS Client ETW 记录同一 RTC 域名，ClientPID 对应本轮 Electron Network Service。Chromium NetLog 独立记录 RTC 和预取域名的 DNS transaction，并通过 source dependency 关联到发往本机 DNS 的 UDP 字节事件。此处泄漏的是测试域名解析；没有以此推断官网内容或凭据已经泄漏。

暂不启用真实 Claude 页面。下一项工作是修复解析边界并重新验证，同时检查更新功能的兼容性：managed-updates.cjs 当前也使用 Chromium 的 net.fetch，简单全局屏蔽 Chromium DNS 可能破坏正常更新。不能仅增加一个开关就宣布问题解决。

## 实际路径与运行

普通权限 Node24 启动 Electron，诊断 wrapper 最终加载正式 apps/desktop/electron/main.cjs，通过正式 preload/IPC 连接回环自有服务并打开真实 WebContentsView。没有 Playwright 启动开关、远程调试端口或管理员浏览器。

测试专用替换只涉及自有 HTTPS URL、精确主机与精确证书指纹，使用独立新 profile。离线服务明确注入回环 lookup/dial；本轮不经过 Ubuntu，不能与上一轮 Ubuntu 实验拼接为同一次端到端验收。产品代码没有添加证书例外。

保留的私有运行目录：

- .local/cc-native-network-479f5e50/dry-run/：测试握手修复后的原生入口功能检查。
- .local/cc-native-network-9b198540/：管理员 PktMon 抓包及普通权限原生入口运行；完整 nonce 以本地 run.json 为准。

抓包窗口 UTC 17:41:00.462 至 17:41:24.116，浏览器进程窗口 17:41:11.789 至 17:41:23.077，覆盖本轮浏览器运行。PktMon 已停止，导出后状态为“数据包监视器没有运行”。没有添加、删除抓包筛选器，原始 ETL、PCAPNG、DNS 事件和 NetLog 仅保存在本机忽略目录。

## 已通过的功能检查

- 正式主进程设置 QUIC 禁用、DNS 预取禁用开关和 WebRTC IP policy；断言没有 Playwright 的后台网络禁用开关。
- 正式 IPC 打开网页，网站 renderer 中没有 Node、process 或客户端 IPC。
- session 使用固定回环代理，没有 DIRECT 回退；自有 HTTPS 假 POST 成功。
- 8 秒 WebRTC 探测没有 ICE candidate；本机 IPv4/IPv6 回环 STUN 监听没有收到数据。WebTransport 被拒绝。
- 停止自有代理后，网页新请求失败；关闭网页、断开控制连接和退出诊断进程完成。

以上检查通过不抵消 DNS 缺口。runner 的成功标记仅表示功能检查完成，系统网络隔离仍须独立审查。

## 抓包证据的范围

分析器仅输出特定 nonce 查询、NetLog UDP 元组及聚合信息，不输出无关报文内容。

- 自有 VPS 的固定假 UDP 阳性标记捕获 1 个 observation，证明相应采集路径能看到发送；不是完整传输次数统计。
- Windows DNS ETW 看到了 RTC nonce 查询，但独立 OS DNS 阳性查询没有出现。预取域名也没有出现在 ETW；它的发送证据来自 NetLog。因此不能把 ETW 未记录某域名解释成没有解析。
- 捕获 1 个含完整 RTC nonce 首标签的 DNS 出站 observation；128 字节前缀截断了部分域名后缀，ETW 补充完整域名。PktMon 多组件会产生重复记录，不能把 observation 数解释为请求次数。分析器排除阳性控制标签及 DNS 响应，避免控制请求延迟进入浏览器窗口而误报。
- 出站 OS 报文端口为 65263，与 NetLog DNS socket 端口不同，未匹配到 NetLog 精确元组。关联依据是相同 nonce 域名及 ETW 的 Network Service PID，不能称它们是已匹配的同一网络流。
- PCAPNG 的接口丢包计数为 19，PktMon 停止输出另称“无事件丢失”。接口计数与 ETW 事件丢失不等价；本轮不作无丢包或零泄漏认证。
- NetLog 的 TCP 连接尝试全部指向回环；多个 IPv6 路由探测 UDP socket 没有字节发送记录，相应精确元组没有匹配到抓包。该观察只适用于本轮时间窗口，不能推广到所有 IPv6 行为。
- 自有 VPS 没有可用公网 IPv6 目标；公网 IPv6 端到端测试仍未完成。
- 系统抓包还含访问自有 VPS 的连接，未确定其进程归属；仅目标 IP 相同不能归因给内嵌网页，这些连接没有被算作网页直连证据。

## 诊断工具修复与复核

本轮修复了测试工具的 Windows stdin 握手：旧原生诊断两次等不到确认，保留失败记录；替换为独立运行目录中 nonce 校验的确认文件，未修改产品通信。抓包助手先核对管理员身份、空闲状态与无筛选器，启动后和停止前检查自己的日志路径；状态不明时保留失败标记、撤销 ready，提示人工核对，拒绝停止他人的抓包。超时使用单调 Stopwatch。

Windows PowerShell 5 首次不能识别重定向后的中文状态，拒绝启动；明确 UTF-8 解码后本机运行成功。另一轮用户粘贴含提示符和旧报错，没有执行脚本；不计入测试运行。抓包读取器额外覆盖 PktMon 将原始 WLAN 数据帧放在 Ethernet interface 下的情况，必须匹配具体数据帧结构及 LLC/SNAP，避免把未识别帧当作“无网络”。

## 后续门槛

修复后需再次跑原生入口，要求 RTC、预取及其他网站解析不走本机 DNS，并补足有效的 DNS 阳性对照。随后才能安排 Ubuntu 正式链路的完整复测。生产审核准入、真实登录、账号区处理、附件原生交互及安装器验收仍按原计划单独处理。

## 本轮回归

Node24 定向测试 69/69、真实 Electron 隔离/生命周期测试 1/1、Chat/Coding UI 回归 4/4、Python 读取器回归 9/9 通过，类型检查通过。这些是已有功能和工具的回归结果，不能写成网络隔离验收通过。独立只读复核确认 DNS 阻塞结论，并要求修复分析器同名 transaction 聚合及阳性控制误报风险；两项已修复并补充读取器回归。
