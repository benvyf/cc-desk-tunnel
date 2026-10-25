# 修复后的浏览器与 Ubuntu 出口联调

2026-10-26 香港时间，代码基线 `e78b00d`。本轮将正式主进程的 DNS 设置、实际网页模块、Ubuntu 独立 v2 测试代理和自有 HTTPS 测试站放在同一取证窗口中验证。指定功能和链路检查通过，没有发现本轮网页探测从 Windows 进行 DNS 查询或直接连接测试站的证据；系统层结论仍为 `REVIEW_REQUIRED`，不作所有流量零泄漏认证。

未访问 Claude、登录账号、迁移 Cookie、修改生产 CC 配置或发布安装器。

## 实际链路与范围

本地真实 Electron 网页 → 随机数字回环 HTTP 代理 → 经证书指纹验证的 v2 WSS → 本轮独立 SSH 转发 → Ubuntu 测试容器 → Ubuntu DNS 与自有 HTTPS 站点。SSH 在 VPS 只监听回环地址，不新增公网测试监听。

原生诊断通过 `spawn` 启动正式 `main.cjs`，没有 Playwright 浏览器启动参数，确认 `MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`、禁用 QUIC、DNS 预取和非代理 WebRTC UDP 等设置。使用新的私有 profile 和正式 `browser-view.cjs`、`browser-network-proxy.mjs`；网站证书采用正常公共 CA 校验，没有网站证书例外。

**范围限制：诊断程序直接创建受控网页视图，没有经生产 Coding 控制连接后点击 Chat 入口。**实际 Ubuntu v2 鉴权、证书指纹和非法目标拒绝另行通过了本机到 Ubuntu 的检查。此前 Chat/Coding UI 回归已通过，但不能将其表述为本轮真实远端完整 UI 验收。本轮的可见性检查只验证视图隐藏和恢复。

Ubuntu 只运行独立测试代理，复用既有不可变镜像，不拉取或构建镜像。测试容器使用独立 token/证书、只读源码挂载和根文件系统、uid 1000，无生产数据卷；本次管理员确认的容器 IP 为 `172.20.0.2`，标签为 `cc.synthetic-egress-lab=1`。

## 同一窗口的证据

Windows 抓包 UTC 19:04:42.754 至 19:05:18.466，覆盖 UTC 19:04:57.553 至 19:05:17.800 的浏览器运行。取证随机标记为 `6d4bc50346634d81a46bc8ca`，私有目录为 `.local/cc-ubuntu-native-6d4bc503/`。

- 自有测试站记录本轮随机标记的 GET、44 字节假数据 POST、WSS 和显式恢复请求，源地址均为 `115.132.85.120`；Ubuntu 直接访问的独立对照也为该地址。离线标记请求没有到达测试站。仅比较公网 IP 不足以证明路径，因此同时核对以下 Ubuntu 报文和浏览器日志。
- Ubuntu 管理员回传的 tcpdump 输出显示 UTC 19:04:58.366 从 Ubuntu `172.22.248.220` 向 `172.22.240.1:53` 查询 `api.ghostapi.org` 的 A/AAAA；随后可见 `172.20.0.2:39598` 经网桥及 Ubuntu eth0 出站连接 `74.82.201.214:443`。显式恢复时再次出现 DNS 查询和容器出站连接，时间与测试站记录对应。
- Ubuntu 抓包统计为 330 captured、344 received by filter、0 dropped by kernel。使用 `any` 会在多个接口重复观察同一连接，以上不是唯一连接数量。Ubuntu 证据来自管理员终端回传，没有取得该端的原始 PCAP。
- Windows NetLog 中网页域名没有 DNS transaction、UDP_BYTES_SENT 为零，所有 TCP 连接尝试均为 `127.0.0.1` 的随机代理端口。指定 RTC 与预取标签也未出现在出站 DNS 报文中。
- Windows 系统抓包可见各 1 个带本轮标记的 DNS、UDP 阳性 observation，证明此次这两条包采集路径有阳性记录；不是所有解析或 UDP 路径的完整覆盖证明。

## 功能结果与限制

HTTPS、假数据上传、WSS、专用 Worker、Service Worker、附件下载到本地并核对字节、普通新窗口复用当前视图、关闭和显式重开均通过。下载由测试监听器指定本地私有路径，没有人工操作系统保存弹窗。

中途仅切断本轮诊断拥有的本地 SSH 转发，网页请求失败，离线随机标记没有到达测试站；显式恢复转发并关闭重开视图后成功。本轮没有测试未完成 POST 的重复发送，不能替代此前相关实验的限定观察。

Windows DNS Client ETW 成功导出，但未记录本次 DNS 阳性；虽然对应 DNS 阳性报文在 PCAP 中可见，仍不能把 ETW 的网页查询缺失单独视为充分证据。PCAP 接口丢包计数为 17；没有 OS drop 统计项，不能当作零。ETW 的“无事件丢失”也不能替代接口统计。

NetLog 仍可见 IPv6 路由探测 socket 建立，未记录发送字节；没有自有公网 IPv6 目标可做端到端验证。本轮未加入系统强制网络隔离，也未穷尽所有浏览器协议、系统后台程序或攻击场景。系统抓包中发往测试站的其他进程连接不能仅凭 IP 归因为网页流量。

## 执行检查与收尾

独立代理 4 项测试、启动器安全检查、自有测试站 5 项、站点回滚 5 项、SSH 回滚 6 项、抓包读取器 9 项检查通过。功能预检首次在诊断日志收尾失败：读取器把不带地址的 TCP 结束事件当作连接地址。核对 NetLog 原始事件后，改为检查开始事件，重新运行预检及上述双端取证均通过；产品代码没有改动，首次失败证据保留在 `.local/cc-ubuntu-native-017d0472/dry-run/`。

原始 Windows 抓包、NetLog、结果及摘要继续保留在本机忽略目录；12 项证据文件的 SHA256 记录于 `evidence-manifest.json`。自有站点日志位于 `.local/owned-egress-6e7eeced/site-events.json`。不提交测试包、token、密钥、profile 或原始抓包。

收尾已确认：Windows 抓包停止，本轮本机转发端口 18789/18790 无监听；Ubuntu 测试容器停止、18789 无监听、测试网络已回收，生产 CC 仍健康；VPS 的测试站路由、服务、专用 SSH 授权和账号已撤销，测试监听为空，nginx 与 SSH 保持 active。测试目录和证据保留。

后续需单独验证完整客户端 Chat 入口与独立远端完整服务的接线，并审定生产审核准入，再进行真实网页登录和安装器验收。本报告不授权或宣称已完成这些步骤。前一轮本机证据见 [DNS 修复验证](claude-web-dns-fix-validation-2026-10-26.md)，取消补修见 [后续审查](claude-web-dns-followup-review-2026-10-26.md)。
