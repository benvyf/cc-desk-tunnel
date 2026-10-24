# 定制版与原版的 Claude 条款风险核对

核对日期：2026-10-24（香港时间）。用户本轮明确确认：仅本人使用自己的 Claude 账号，不向他人提供账号或订阅额度。

## 后续实际节点校验补充（2026-10-24）

本轮用户又要求在 Ubuntu 官方终端管理登录、客户端仅显示编号。工作区已移除客户端相关入口，服务端账号操作接口改为拒绝；为保持受管升级兼容性，原账号模块保留原始字节，其中远程登录驱动不再由账号入口调用。账号身份元数据改为编号，控制中心仍保留私有邮箱映射。此改动尚未发布，不能把下文对既有登录 UI 的描述当成新源码仍保留该 UI，也不能据此消除原有 SDK/订阅组合的许可未决项。详见 `SERVER-MANAGED-ACCOUNTS.md`。

下文“未发现新增修改官方 Claude 二进制”描述的是受审源码，不能作为实际 Ubuntu 文件原样的证明。首台受管安装器随后拒绝运行环境，完整逐字节比对确认：节点 CLI 与经固定摘要验证的官方 2.1.295 文件相差 1 字节，offset 194437468，官方 `9f`、实际 `f5`。官方完整文件 SHA256 `4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`，实际 `f66a66b89fa1c229ff9edce0065277a2d0897ebd6710f6d3e8b722c6e1d9ec2e`。原因尚未知，不能据此认定恶意篡改、无害差异或违反条款，但在恢复并验真前，不应声称实际节点满足“官方二进制未修改”的条件。此发现本身也不能归因于 JEV hook。

专用恢复脚本通过隔离验证后，用户已在真实 Ubuntu 执行成功，回传完整官方 SHA256、root/0755 校验通过、暂停解除及 `containerRunning: true`。异常文件备份 `/var/lib/cc-cli-official-restore/20261024T025442Z-hi6k94xg`；差异原因仍未知。依据该次输出，恢复后的文件与固定官方原文件一致，但这不等于整个项目已取得许可。用户随后完成受管首次接入（Build 2／协议 20），安装器报告本地就绪通过且没有 Claude/provider 查询，备份 `/var/lib/cc-server-bootstrap/backup-20261024T030534Z-878b97a3`。摘要校验未放宽，未执行 Claude、JEV 或额度查询，未升级 CLI/SDK。进度以 `DEVELOPMENT-HANDOFF.md` 顶部补充为准。

## 结论

在本次检查的客户端、服务端、部署和监控改动中，未发现新增修改官方 Claude 二进制、伪造认证、转发 OAuth token 到管理 VPS、自动切换账号绕过额度或取消 Claude 内容安全机制的实现。

这不足以认定整个产品已经获得 Anthropic 的许可。原版已有的自定义聊天界面、Agent SDK 调用和订阅登录组合，存在需要解释的许可边界；定制版继承了这一组合。本人在未修改的自托管 Claude Code 中登录自己的订阅，有官方文档支持；第三方产品通过 Agent SDK 提供 Claude.ai 登录或订阅额度，则受到官方明确限制。没有找到明确批准本项目这套组合的官方声明，也没有核验单独书面授权。

因此，准确结论是：**未发现本次定制新增明确的上述违规机制；无法据此保证原版或定制版整体符合所有条款，主要未决项是订阅登录与自定义 SDK 界面的许可适用范围。** 本结论不预测账号风控结果。

## 对比身份与方法

- 原版仓库：<https://github.com/sun168567/cc-desk-tunnel>；本轮联网 fetch 后 `upstream/main` 为 `e2ec3dbecf1ac0b58ea2fc2a553f18d36b8a3d32`。
- 定制分支：`codex/account-monitor-production`；本地 HEAD `80e1deaeef61351fee239572873a3269b6752205`。
- 已发布 Windows Build 5、Linux Build 2 的源码为 `9ab5f49f8155076ae5d7eacb33d9e369da4e2199`；与当前 HEAD 的差异仅为文档。
- 原版上述提交也是当前定制分支的共同祖先。按这一明确版本比较，未将旧的本地 upstream 引用当成最新原版。
- 使用 Git diff、文件 blob 身份和相关调用路径进行静态检查；读取公开官方条款与技术文档。
- 未启动 Claude、SDK 会话、真实原生终端、桌面客户端或模型测试；未查询实际账号/额度，未重新登录，未变更生产、Claude 出口或账号配置。
- 本次不是重新执行发布验收，也没有重新核验实际 Ubuntu 镜像或安装包内每个文件。对实际节点的既有验证仍以交接证据为准。

## 客户端与服务端改动

| 范围 | 核对结果 | 对规则的意义 |
| --- | --- | --- |
| Windows 客户端更新 | 新增自有签名索引、下载验签、空闲协调与安装；服务端升级增加精确目标确认 | 管理 CC 自己的程序发布，不是替换 Claude 登录或模型服务 |
| 客户端与 CC 服务端连接 | TLS/代理连接辅助逻辑被抽出供升级复用；处理的是 CC 控制与下载链路 | 不能把开发电脑或 CC 控制连接的代理等同于 Ubuntu 的模型出口 |
| 聊天模型调用 | `apps/server/src/claude.ts` 与最新原版的 Git blob 完全相同，仍使用官方 Agent SDK 和配置的官方 CLI | 没有新增模型认证或请求伪装；SDK 与订阅组合的许可问题仍然存在 |
| 账号登录、退出 | `native-account.ts` 与原版完全相同；驱动官方 `claude auth login/status/logout`，并将登录链接及用户提交的授权码传给官方 CLI | 不是定制新增登录机制，但自定义界面承载订阅登录需要与官方限制一起判断 |
| 引导及凭据读取 | `native-onboarding.ts` 与原版完全相同；会读取本地 `.credentials.json` 的 token 是否存在，并设置完成引导标志 | 不能宣称 CC 完全不接触凭据文件；本次未发现新增把该 token 上传管理中心的路径 |
| 原生终端与设置 | `native-terminal.ts`、`native-settings.ts` 与原版完全相同；新增管理员 command hook 及策略校验 | 使用官方扩展点做额外拦截，不等同于修改 CLI 或绕过 Anthropic 的内容安全机制 |
| 统计与额度 | `usage.ts` 与原版相同；`native-controls.ts` 仅增加两处额度尝试时间字段传递 | 新监控没有另外实现对 Anthropic 的主动额度轮询 |
| 被动账号监控 | `AccountMonitor.observe()` 消费已有身份、额度与 usage 事件；定时/重试只负责发送报告到配置的 VPS URL | 上报白名单元数据，独立节点鉴权；不包含 Claude OAuth token、Cookie、密码或完整聊天 |
| 关键词/JEV 审核 | 输入先向 VPS 审核接口提交，JEV 使用独立配置的 API key，失败时拒绝；原生 hook 会读取会话文本并提取用户输入等待审文本 | 没有新增 Claude 推理测试调用；会新增向审核服务传输文本的数据流，不能把它说成所有数据都留在 Ubuntu |
| 服务端升级/首次接入 | 使用签名程序包和兼容性校验，保留既有运行环境、账号持久化及审核挂载；不将普通业务升级当成 CLI/SDK 更新 | 本次未发现升级路径注入新的 Claude 账号、认证 token 或模型代理；当前实际节点是否执行接入需另外确认 |
| 官方 CLI 安装 | `scripts/install-linux.sh` 改为固定官方原生分发包和摘要校验；未发现对二进制做补丁 | 固定版本本身不能证明全面合规，也不应理解为永久不用维护官方安全更新 |
| 依赖 | `package-lock.json` 与原版完全相同 | 本次没有通过锁文件引入另一套模型 SDK 依赖 |

以下自动行为由原版继承，不能因为“新增监控是被动的”就称整个客户端完全离线：连接后可请求 `account.status`；界面状态刷新可请求 `session.status`；后者通过 CLI/SDK 初始化和状态方法读取身份/额度。没有提交用户提示词，不等于没有任何 Anthropic 辅助网络请求。

原版存在的本地工具权限模式、追加远程执行提示词等机制，也不能仅凭名称判为绕过模型安全。此次没有发现定制改动新加移除模型安全约束的提示词或认证伪装。

## 官方规则与项目的对应关系

### 1. 自己登录未修改的 Claude Code 有明确的允许场景

[Claude Code Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) 说明：

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code ...

同页的产品托管条件要求官方二进制不被修改，不移除、禁用或限制内置认证方法；如对外提供产品/服务，还涉及 Commercial Terms、最终用户自行认证，以及不得代付、转售或代为中转使用等要求。

用户确认的“本人自用”不属于已确认的他人共享或转售场景，不应擅自把账号监控等同于账号贩售。但该允许场景不能自动扩大为所有自定义 Agent SDK 产品均可使用订阅凭据。

### 2. 第三方产品的订阅登录与额度集成存在明确限制

[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md) 写明：

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods ... instead.

法律页还要求构建 Claude 集成产品/服务的开发者使用 API key 或支持的云提供商，并限制替用户路由订阅请求、收集/保存/中转 Claude.ai 凭据或会话 token。必须同时理解它允许用户自行登录官方未修改 CLI 的段落。

本项目的 `claude.ts:151` 通过 SDK `query()` 提交自定义界面中的输入；`native-account.ts:40` 承载官方登录命令的交互。没有改二进制并不能单独解决该组合的许可适用问题。这是原版与定制版共有的主要未决风险，并非新增监控独有的问题。官方文档没有对本项目作出专门认定，故不将该风险写成已经确认违约，也不写成已经确认获准。

### 3. 本人使用也要遵守订阅与认证限制

[Consumer Terms](https://www.anthropic.com/legal/consumer-terms)（本轮读取页面标注生效日期 2025-10-08）禁止把账号登录资料或账号提供给他人，并限制未经明确许可的自动化访问等行为。官方 Claude Code 本身有允许的自动化能力，不能据此把所有 CLI、SDK 或定时任务一概判为禁止。

[Pro/Max 与 Claude Code 官方说明](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)说明订阅额度由 Claude 与 Claude Code 共享，达到限制时可等待重置、按官方选项升级/增加付费用量。

拥有多个本人的账号，不由这次静态检查直接认定违约；被动查看多个账号也不等于绕限。不过，若以后将管理中心发展为用账号轮换绕过使用限制或处置的工具，需要重新评估。当前代码没有实现自动换号、账号池调度或批量登录，不应为了验收新增这些功能。

### 4. 官方扩展点与隐私配置

[Hooks 官方文档](https://code.claude.com/docs/en/hooks.md)支持 command hook 在用户提交、工具批次、压缩等事件运行本地处理并作出拦截决定。本项目的附加审核通过这些扩展点实现，JEV 放行也不代替 Anthropic 自己的审核或使用规则。

[数据与遥测官方文档](https://code.claude.com/docs/en/data-usage.md)公开支持 `DISABLE_TELEMETRY=1` 和 `DISABLE_ERROR_REPORTING=1`。使用这些设置本身不等于篡改官方客户端或自动违约，也不是规避账号风控的保证。

本轮读取的 [Usage Policy](https://www.anthropic.com/legal/aup) 页面标注生效日期为 **2026-11-12**，晚于本轮香港日期。未确认其此前适用版本，因此没有把该未来生效文本的具体禁令当成今天已经生效的判定依据；上述核心结论依据直接读取的法律页、SDK 文档和消费者条款。账号地区与实际内容用途亦不在这次代码差异核验的证明范围内。

## 继续工作的建议

1. 如果继续本人订阅方式，优先在官方未修改 Claude Code 的原生界面中使用账号；额外的审核 hook 和被动状态记录仍需遵循数据与使用要求。不能把切换原生界面视为已取得整体产品许可。
2. 如果需要保留自定义聊天界面和 SDK 业务处理，API key 或受支持云提供商是官方文档明确推荐的集成方式；API 用量与 Pro/Max 订阅不是同一份额度，切换需单独决定并验收，不能静默替换。
3. 如果要在本项目自定义界面继续使用 Pro/Max，最有价值的确认是向 Anthropic 提供“仅本人、自托管、官方 CLI 未修改、SDK 调用及登录交互”的准确结构并取得明确答复；本轮没有代用户联系任何人。
4. 暂不增加账号池、自动换号或对第三方额度的主动轮询；保留当前已有代码与生产状态。本报告不包含自动整改、发布或回滚安排。

本次仅新增这份审查文档，没有修改程序、依赖或生产配置。没有运行与静态条款核对无关的测试。
