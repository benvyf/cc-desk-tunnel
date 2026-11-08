# 当前程序的 Anthropic 合规复查

复查日期：2026-10-29（香港时间）。源码：`172ce028bbccc73229ce54d031c840c0ff51dfe4`，分支 `codex/terminal-status-coordination`。范围为当前程序的调用、认证、终端、定时任务和相关数据流；本次不改变代码、认证、费用或生产部署。

## 结论

**当前程序不能认定为已全面符合 Anthropic 条款与 Usage Policy。主要缺口是自定义聊天及其后台状态读取使用 Agent SDK，却没有把认证限制到 API key / 官方支持的云服务。若实际继承的是 Pro/Max 等个人订阅凭据，该路径不具备本次可核实的明确许可依据，应先整改或取得覆盖该架构的批准。** 不能以“本人自用”“SDK 会启动官方 CLI”或“没有修改官方二进制”直接替代这一授权判断。

这不是对账号已违规、已封禁或 Anthropic 已作出执法结论的断言。代码支持某种用法不证明它已经发生；实际认证、适用合同与部署事实需要和代码结论区分。

同一法律页也写到 Pro/Max 的公开限额假设为 Claude Code 与 Agent SDK 的普通个人使用。该表述涉及用量假设，不能单独当作所有自定义 SDK/订阅组合的授权；反过来，也不能忽略用户纯自用的事实，把“第三方向其用户提供订阅登录”的禁止条款直接套成“已证明这位用户个人使用 SDK 违约”。本报告因此将这一组合列为许可未决，而非已确认违反。

用户在本轮确认：仅本人使用自己的 Claude 账号，也使用 CC 自定义聊天界面，没有其他人通过邮箱授权访问同一节点，实际使用地区为马来西亚。这排除了目前已知的个人账号共享场景；官方访问地区帮助页明确列出 Malaysia。没有根据 VPS 位置、时区或出口 IP 推定使用者资格。

用户补充登录方式为“服务端给官方授权链接，点击授权后使用”。已追踪源码：遗留 `NativeLogin` 在 `native-account.ts:63` 附近执行配置的 CLI 的 `auth login`，从其输出取出链接，并将用户提交的授权码交回该进程；当前 `server.ts` 的客户端账号操作入口已经拒绝该登录驱动，既有部署文档要求在 Ubuntu 官方终端完成登录。自定义聊天仍由 SDK 启动同一配置的 CLI，并继承其环境/可见认证配置；源码没有另行建立一个明确隔离的 API 认证路径。官方链接证明采用官方授权流程，不能单独证明 CC 自定义 SDK 界面获得了订阅集成许可。由于未读取真实节点的认证状态和配置，本次也不能仅凭“官方链接”确定当前实际 provider、套餐或是否有 API key 优先覆盖。

## 官方依据与版本

本轮重新读取以下官方页面，未沿用旧报告作为当前政策原文：

| 来源 | 本次核实内容 |
| --- | --- |
| [Claude Code 法律与合规](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) | 允许最终用户在未修改的官方 CLI 中用自己的订阅登录；开发自建产品/服务（包括 SDK 集成）应使用 Console API key 或支持的云服务；禁止向自己的应用提供 Claude.ai 登录、代用户经由个人订阅路由请求，以及收集、保存、中转 Claude.ai 凭据/session token。 |
| [Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview) | 除非事先批准，不允许第三方开发者向其产品提供 Claude.ai 登录或订阅额度；指向 API key 认证。SDK 产品有单独品牌限制。 |
| [消费者条款](https://www.anthropic.com/legal/consumer-terms) | 页面标注 2025-10-08 生效；不得共享账号/凭据或把账号提供他人使用；除 API key 或明确允许的情形外，禁止自动化/非人工访问；禁止绕过保护措施。官方 CLI 的合法代理行为不能仅因自动执行工具就一概判禁。 |
| [商业条款](https://www.anthropic.com/legal/commercial-terms) | 页面标注 2025-06-17 生效；API、商业使用及 SDK 适用合同须明确，API key 本身不是全部用途获准的证明。 |
| [Usage Policy：2025-09-15 历史正文](https://www.anthropic.com/legal/archive/22742366-2ef0-4c7a-a833-6523f10d3944) | 本次已通过官网版本历史取得原文。包含通用禁止用途、高风险用途要求和 agentic use 等条目。按当前日期及本次取得的版本历史，以该版本作为本次内容用途核对依据。 |
| [当前 Usage Policy 展示页](https://www.anthropic.com/legal/aup)及[地区政策展示页](https://www.anthropic.com/legal/supported-regions) | 两页均标注 2026-11-12 生效，晚于今天。虽然官网称历史页已被替代，仍不能把这些未来文本当作 2026-10-29 已生效条款；版本/生效标签存在时间差，发布时须再次核对。 |
| [官方访问地区帮助页](https://support.claude.com/en/articles/8461763-where-can-i-access-claude) | 标注 2026-03-16，明确列出 Malaysia；这是本次地区判断的直接依据。没有将未来地区政策的实体/控股限制套用为今天的确定结论。 |
| [并行 worktree 使用示例](https://code.claude.com/docs/en/common-workflows#run-parallel-sessions-with-worktrees) | 官方介绍多个终端独立并行会话。因此多标签、多个官方 CLI 进程本身不构成已发现的禁用行为，仍受认证、用量和实际用途要求约束。 |

本机原文快照位于 `.local/compliance-review-2026-10-29/`；可保留的来源、页面日期与 SHA256 清单见 [政策证据清单](evidence/anthropic-policy-review-2026-10-29.json)。这些证据不包含账号凭据，不属于安装包。

## 程序发现与优先级

### 1. 高优先级：自定义聊天的认证边界未落实

- `apps/server/src/claude.ts:165`：`runClaude()` 用 `query()` 执行用户聊天。它指定官方 CLI 可执行文件，并合并 `process.env` 与 `options.environment`。
- `apps/server/src/claude.ts:486`：`readNativeStatus()` 同样启动 SDK，继承认证环境；不是纯本地数据库查询。
- `apps/desktop/src/App.tsx:663` 附近：首次展示空闲会话会自动请求状态；`App.tsx:904` 经 `session.status` 到 `apps/server/src/server.ts:707` 的 `readStatus()`，最终进入上述 SDK。
- 这些入口未按订阅/API/云认证分开授权。没有发送提示词不等于完全没有 Anthropic 辅助网络行为。

**处置：** 若保留自定义聊天，采用单独明确的 API / 支持云认证及费用归属，或取得覆盖此自托管 SDK/订阅架构的明确批准。不得静默切到收费 API。若选择仅用本人订阅的原生 CLI 模式，须同时关闭或替代 SDK 聊天、后台状态初始化及其他 SDK 入口；仅隐藏输入框不够。

当前实际认证尚未通过节点核实。若已使用合法 API / 云认证，上述问题收窄为认证隔离与合同/配置证据，不能继续把它称为已经发生的订阅调用。

### 2. 高优先级（启用时）：定时任务没有认证门槛

- `apps/desktop/src/schedules.ts:272` 起按计时器触发任务。
- `apps/desktop/src/App.tsx:993` 起的发送回调最终调用 `message.send`，进入同一 SDK 聊天路径。
- `apps/desktop/src/SchedulePanel.tsx:453` 提供政策提示，但执行时没有按认证来源阻止未经确认的订阅自动化。

本次没有读取用户任务文件，不能认定用户已启用无人值守任务。官方 CLI 自身获支持的自动化功能与 CC 自己经 SDK 定时发消息需要分别判断，不能一概禁止全部 CLI 自动化。

**处置：** 在 SDK 认证未明确前，不启用该路径的订阅定时任务；若保留此功能，应在服务端最终 SDK 调用边界落实对应授权模式，不能只增加客户端提示或仅在定时任务按钮上拦截。

### 3. 原生多终端：未发现多开本身新增绕限机制

`apps/server/src/server.ts:752` 的 `openTerminal()` 启动 PTY 和配置的 CLI；`apps/server/src/native-terminal.ts:42` 的参数沿用用户配置、模型和权限。复用会话所有权、容量及受管审核，没有因增加标签就新增 SDK 提示词、轮换账号、伪造请求身份或提高订阅额度。

`terminalEnvironment()` 会继承环境及私有设置，所以“打开原生终端”也不保证一定是订阅计费或一定是 API 计费；应明确实际配置。现有 `bypassPermissions` 是工具权限模式，不能只凭其名称判为绕过 Anthropic 内容安全，但不应为了多开自动提高权限。

符合未修改 CLI、自行认证、普通合法使用等条件的本人原生终端场景有官方支持。若将来对外托管，还须另行满足 Commercial Terms、每位最终用户自行认证/承担用量、不得转售或代中转使用等条件；这不是当前已确认的多人场景。

### 4. 认证与官方程序完整性：源码改善已确认，生产状态未复核

- `apps/server/src/server.ts:696`：除 `account.status` 外的账号操作被拒绝，引导用户在 Ubuntu 官方终端登录。`NativeLogin` 等遗留实现仍在文件里，但此账号入口不调用它，不能把文件存在当成当前远程登录功能仍开放。
- `native-onboarding.ts` 仍包含读凭据并写引导标志的历史 helper；本次搜索未发现生产代码调用点，终端启动已去除依赖。不能把它描述成当前每次开终端仍会读取 token。
- `scripts/install-linux.sh` 使用官方分发包和固定完整性值，没有在本次受审路径发现二进制补丁；未重新读取真实 Ubuntu 节点二进制，不能凭脚本或旧恢复记录宣布今天所有节点都原样。
- 原生 PTY 输入输出可能经过官方登录链接或用户粘贴的授权码。即使没有专用登录表单，也不能声称 CC 永远不承载认证字节；本次未发现新增专门提取这些字节并上报的逻辑。

**处置：** 继续让本人通过官方流程登录；发布时核验实际制品、CLI 来源/摘要及认证环境。此处不要求改写官方程序或拦截其内置登录方式。

### 5. 审核、数据与用途：有拦截不等于全面符合 Usage Policy

`apps/server/src/moderation.ts:50` 将待审文本发送至配置的 HTTPS 审核服务；`native-moderation-hook.ts` 会读取会话文本并形成待审内容。`account-monitor.ts:61` 起上报账号邮箱、订阅/组织等白名单元数据。这里的节点鉴权 token 与 Claude OAuth token 不应混为一谈。

本次未发现这些路径新增向管理中心上传 Claude OAuth token 的实现；但不能说全部输入和账号元数据都只留在 Ubuntu。审核服务的数据保留、是否再转交其他审核模型、实际提交内容的权利和敏感性，需要按实际配置说明。额外审核放行不代表 Anthropic 批准该用途。

仅凭源代码无法证明所有历史/将来提示词和工具动作都符合 Usage Policy。本次没有抽查私人聊天、真实提示词或审核服务留存。也没有发现应仅凭“远程开发/多标签”就直接归入禁止用途的依据。

### 6. 品牌：保留自有产品身份，区分 SDK 界面与原生输出

当前产品使用 CC 自有品牌；未在本轮新增 UI 中发现仿造官方标志。原生 CLI 自己输出的官方界面与 CC 自画内容应区分。SDK 概览明确限制集成产品使用“Claude Code”命名及仿官方视觉；`App.tsx:1357` 等自定义聊天适配器名称建议使用“Claude”或“Claude Agent”，并清楚表述其为独立客户端。事实性的“运行官方 Claude Code”说明与原生终端输出不应机械删除。

这是品牌边界建议，不据此断言当前所有设置标题已违规。

## 建议的最小整改顺序

1. 明确自定义聊天实际认证及 SDK 使用授权：API / 支持云认证，或取得覆盖实际架构的明确批准；原生 CLI 订阅模式单独保留。
2. 在最终 SDK 执行边界约束未经授权的订阅组合，同时覆盖手动聊天、后台状态和定时任务；按实际 provider 明确费用，不静默转换。
3. 发布前核验真实 CLI 与认证配置，说明审核数据流；有对外服务计划时再补多用户隔离、商业托管和品牌核对。

本次为复查报告，不自动执行以上整改，不更改计费、不联系 Anthropic、不登录或查询生产账号。源码证据不能替代实际部署核验；未来发布也不能直接沿用本次页面版本而不核对生效日期。
