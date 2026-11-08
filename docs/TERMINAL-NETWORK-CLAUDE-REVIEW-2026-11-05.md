# 终端优化再次审查：网络边界与 Claude 使用要求

日期：2026-11-05（香港时间）。按用户要求复查当前未提交的终端优化与直接调用路径；遵循 karpathy-guidelines 的最小范围原则。本轮未修改产品功能、生产配置、SDK、CLI 或认证方式。

## 结论

**本次终端优化未发现新增网络越界、修改官方 CLI/SDK、伪造 SDK 身份或跳过管理员审核的实现；相关 81 项测试全部通过。**

**整套生产部署的凭据授权适用范围和真实模型出站线路尚未在本轮核实，不能据此确认全部符合 Anthropic 条款。** 特别是“用户自行登录未修改的官方交互 CLI”和“第三方产品使用 Agent SDK 处理请求”适用要求不同。以下记录将工程证据与使用前提分开，不把待核实配置当成已证实违规，也不把测试通过当成官方许可。

## 1. 改动与网络边界

| 路径 | 本次核对结果 |
| --- | --- |
| 终端进程与输出合并 | `apps/server/src/native-terminal.ts` 继续在服务端启动官方 CLI，仅合并既有 PTY 输出；不新增 HTTP 请求、认证参数或输入重放。键盘仍走原输入管道。 |
| 本机预测回显 | 原独立覆盖层不发模型请求、不写入真实 buffer/剪贴板/会话历史。本次没有改变预测算法或增加模型运行依赖。 |
| 桌面执行通道 | `tunnel-channels.mjs` 仍只连接 `127.0.0.1` 上既有 SSH 服务，并使用已核验服务身份的 dial。10 秒关闭上限只影响正常 EOF，不新增监听或放宽服务端证书/secret 校验。 |
| 终端历史与上下文状态 | 新的 `readTerminalContext` 复用现有安全文件打开逻辑，限定到所选 CLI 配置、项目和原生 UUID，只读 stat。消息读取继续使用官方 SDK 的自定义只读 sessionStore；不调用 `query`、账号登录或凭据接口，不扫描其他历史目录。 |
| 完整包获取入口 | renderer 只传目标协议数字；主进程通过控制器重新验签索引、校验目标 Build/协议/账本，再从固定 origin 与制品路径生成地址。renderer 没有提供任意下载 URL。跨协议自动下载安装继续拒绝。浏览器手动获取完整包与应用内已校验自动安装是不同流程。 |
| 真实模型调用 | 现有 `apps/server/src/claude.ts` 的 `query` 在 Ubuntu 服务端执行，保留 `CLAUDE_CODE_ENTRYPOINT: 'sdk-ts'`。交互 PTY 清除 SDK 标记只作用于直接启动交互 CLI 的既有路径，不会给 SDK 请求套用这个行为。本次没有改动 SDK 的入口或环境构造。 |
| 管理员审核和监控 | 审核 UserPromptSubmit hook、只读策略挂载、账号操作限制保持。已有新消息审核会向管理中心发送待审核文本；监控会发送账号/用量元数据，不能称为所有数据只送 Anthropic。本次没有扩大上报内容或加入 OAuth token/凭据传输。 |

通过 Git 差异确认：本轮未修改 `claude.ts`、CLI 安装脚本、Dockerfile、SDK/CLI 依赖锁、native-deployment、native-terminal-policy、native-moderation-hook、moderation，或既有主进程更新 IPC/验签控制器。

“调用在 Ubuntu 进程里发起”不能证明实际公网出口属于哪台机器。真实出站还取决于进程环境、provider/settings、Docker/NAT、HTTP(S) 代理和网关。本轮没有读取生产私密配置、抓取用户会话流量或用普通公网 IP 探测冒充 Claude 出站验证。现有部署历史中提及的 Windows 宿主代理/NAT也不能自动认定为当前线路。

## 2. 本次实际读取的官方文档

本次成功获取并阅读以下官方页面的 Markdown 内容；此前其他报告中的 403 是历史取证结果，不再作为“当前无法读取条款”的依据。

- [Claude Code 法律与合规](https://code.claude.com/docs/en/legal-and-compliance.md)
- [Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview.md)
- [Claude Code 网络配置](https://code.claude.com/docs/en/network-config.md)
- [Claude Code 认证](https://code.claude.com/docs/en/authentication.md)

与当前项目直接相关的要求：

1. 平台托管/产品预装 Claude Code 的场景需满足页面所列商业条款及条件；官方二进制不能修改，也不能移除、禁用或限制其内建认证方法。
2. 法律页明确允许终端用户自行在未修改的官方 Claude Code 中登录其订阅，包括平台托管的官方 CLI；这不等于许可开发者收集、中转 Claude.ai token、替用户转售或代理订阅用量。
3. 法律页要求构建 Claude 产品/服务的开发者使用 Console API key 或受支持的云提供商。SDK 概览另明确：除非事先批准，第三方开发者不得为其产品提供 claude.ai 登录或使用其限额，应使用 API key 认证方法。
4. 自定义 prompt、官方 hook、工具权限选择和模型安全政策是不同层次。本次未将关闭工具审批说成关闭内容安全，也未新增绕过认证、额度或模型安全机制的代码。
5. 官方网络文档支持 HTTP/HTTPS 代理和自定义 CA 等配置；使用代理本身不证明违规，也不证明请求出口符合本项目规定，仍须核对实际线路。不能通过关闭 TLS 校验来处理连接问题。

## 3. 仍须核实的使用前提

现有聊天路径确实使用 Agent SDK 并继承服务端配置。源码没有足够信息证明每台生产节点实际使用 API key、云凭据还是订阅凭据，也无法证明是否具有适用的 Anthropic 单独批准。

因此，**若 SDK 路径作为第三方产品/服务替用户处理请求，不能在未确认授权的情况下认定订阅凭据可用**；应核实其 API/云凭据方案或明确批准。直接交互的官方 CLI 应由用户通过官方流程自行认证。发布前需据实际部署用途确认这项前提；不能通过去掉 SDK 标记、修改 CLI、伪造环境或关闭审核来解决。

本轮没有为消除这项不确定性而读取或导出 token、登录真实账号、替换生产凭据，或发送真实模型请求。实际 Ubuntu 节点的认证模式与路由可通过后续最小化、脱敏的只读配置核验确认；账号所有权、用途与许可仍需要实际使用方的事实依据。

## 4. 验证与证据

- `node scripts/check-model-boundary.mjs`：通过；检查实际工作区的桌面模型运行依赖与导入。
- 81/81 相关测试通过，0 失败、0 跳过：model-boundary、managed-client、tunnel-channels、native-deployment、native-moderation-hook、moderation、native-terminal、terminal-controls、terminal-history。
- 覆盖签名与防回放、目标协议下载限制、网络下载来源限制、审核策略、原始 PTY 输入、配置目录/原生历史隔离、空/坏/大记录、SSH 关闭与错误路径。
- 测试使用回环网络、临时文件、受控 PTY/模型边界替身和测试签名，不访问生产模型或执行安装器。本轮未重跑先前已验收且未修改的 GPU/布局、性能和真实远端 PTY 基准。
- 测试日志：`.local/terminal-boundary-review-tests.log`；官方页面快照与 SHA256 记入 [机器可读证据](evidence/terminal-optimization-2026-11-05.json) 的 `boundaryReview`。

本轮未发现新的需修改代码的阻断问题，未增加防御框架。未打包、签名、发布或部署；整体生产合规和真实出口仍以上述未决前提为界。
