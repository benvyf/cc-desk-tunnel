# 原生终端强制审核可行性评估

2026-10-30 范围更新：用户最终仅要求审核聊天/终端新消息，最新本地实现见 [消息审核范围与上线说明](NATIVE-HOOK-LARGE-HISTORY-FIX.md)，尚未部署。本文保留早期四事件/全历史门禁的实验依据；不再将独立问答、权限补充、压缩和展开审核作为新范围的启用要求。

评估日期：2026-10-23（香港时间）。用户选择保留强制审核，先评估官方支持方式，确认可行后才恢复。

结论：官方 **2.1.295** 的受管 command hook 已完成 VPS 隔离验证，但 `ubuntu-cc` 补测暴露 Tab 修改要求漏审。候选已补充本批历史持久化检查，仍待目标节点重验。生产仍是 **2.1.293**，原生终端继续关闭；**目前不能切换生产或宣称全面覆盖**。本轮真实 Claude/JEV 请求均为 0，模拟请求仅到达无网络容器内的 loopback stub。

后续进度：用户已在 `ubuntu-cc` 完成 `85876c41ffce` 准备脚本，候选镜像为 `sha256:7154d370f8e551098a41db4a6ed58fb6d127a0852cb0fd474c6860b4f10122eb`。实际普通输入、问答、压缩及 SDK 测试通过，正式服务未变，`activationReady=false`。下述补测发现权限弹窗修改要求的缺口，已修改候选源码；旧候选不能直接激活，需执行补测脚本生成修正版并通过目标节点验收。

## 补测与限制调整

目标节点运行 `adf26f5b4279` 时，前三项扩展场景完成，但 Tab 修改要求在 `permission feedback reviewed` 超时；审核记录仅有旧提示，模拟模型请求已包含拒绝标记。此前 VPS 的通过结果不足以证明跨节点安全，不能激活该候选。

后续隔离取证发现，官方 PostToolBatch 参数只有工具响应，不包含 Tab 新增文字；新增文字随工具结果保存在同一条 user 历史记录中，持久化存在异步时序。原 hook 没有检查读到的历史是否含本批工具结果，旧历史也可被审核通过。修正后必须读到本批所有 tool_use_id 对应的工具结果，才审核该快照；仅对未落盘状态每 50ms 重读本机文件，最多 1 秒，仍未完成就阻断。JEV 仍只调用一次且不重试。新增回归验证旧快照不触发审核、延迟落盘的修改要求被拒绝、超时不放行。

故障日志也已改为 JSON 转义，PTY 控制码不会随日志显示而重绘终端。此前直接 tail 原始 PTY 日志造成的画面混乱是诊断输出问题，不代表启动了生产 CLI。

真实 PTY 已验证排队输入和恢复历史会触发 `UserPromptSubmit`，权限弹窗选择 No 后填写下一条说明也走普通提交审核。但 Tab 修改要求会将新用户文本放入会话后继续工具批次，不触发 `UserPromptSubmit`，也不一定产生错误工具结果。旧候选只在交互或错误工具后审核批次，已经在模拟接口复现漏审。

修正版在**每个工具批次结束后**审核用户文本历史，包括该次修改要求；仍不把普通文件/工具输出全部送审。修复后 Tab 修改要求已在真实 PTY 中被拒绝，未到达模拟模型。这样会增加 JEV 次数和延迟，不能再声称普通工具批次不增加 JEV 用量；不会由审核钩子额外调用 Claude。

最终合并测试已通过：`nativePromptReviewed`、`nativeQuestionAnswerReviewed`、`compactInstructionsReviewed`、`queuedPromptReviewed`、`resumedHistoryReviewed`、`permissionDenialFeedbackReviewed`、`permissionAmendFeedbackReviewed`、`unsupportedCommandExpansionBlocked`、`sdkCompatible` 均为 true；三项初始拒绝到达模拟模型标志均为 false，扩展路径也逐项检查被拒文本未到达模拟模型。实验结果保存于 VPS `/var/lib/cc-native-hook-lab-2.1.295/sdk-lab.log`。类型检查及本轮四项 hook 核心测试通过。

另一个官方限制是 `UserPromptExpansion` 提供原始命令行而非展开后的完整技能正文。因此修正版明确阻断直接调用的自定义提示命令/技能展开；`/compact` 等独立处理的内置操作依其对应钩子审核，不能据此说所有斜杠操作都被禁用。工作区文件、技能描述等外部上下文本就不属于本次文本输入门禁的全面隔离范围。

`scripts/verify-native-terminal-paths.py --source <完整 SHA>` 复用节点已验收的官方 CLI/SDK，只 overlay 修正后的 hook，校验其他受保护文件和运行配置不变。脚本在无网络、无生产数据/账号挂载的容器执行普通输入、交互回答、压缩、排队、No/Tab 反馈、自定义命令限制及历史恢复测试。通过后输出 `inputPathAcceptancePassed=true`，仍是 `cutoverPerformed=false`；不启用生产终端、不修改凭据/出口/阈值。原版本的故障阻断测试已通过，未更改的官方二进制、受管策略无需再次研究。

## 官方支持与当前版本差异

| 项目 | 官方行为 | 对本项目的影响 |
| --- | --- | --- |
| `UserPromptSubmit` | 在处理用户提示前执行，可用 `decision: "block"` 或退出码 2 拒绝 | 可作为终端普通文本的审核入口，不能仅凭事件名宣称全部输入覆盖 |
| 异常与超时 | 默认多数 hook 失败后仍执行原操作；UserPromptSubmit 超时后提示仍可到达 Claude | 当前版本不能把 hook 的正常拒绝当成审核程序故障时也会拒绝 |
| `onFailure: "block"` | command/http hook 的启动失败、异常退出、超时、无效 JSON 等可阻断；要求 **2.1.295 及以上** | 当前 2.1.293 不具备该受支持选项；不能写入新字段并假设它生效 |
| 受管审核 hook | managed policy 中的 hook 不被普通 user/project/local 的 `disableAllHooks` 关闭；Linux 系统文件为 `/etc/claude-code/managed-settings.json` | 普通 settings.json 或临时 `--settings` 中的 hook 不足以承担强制策略；需要管理员拥有、执行用户不可写的受管配置与审核程序 |
| 原生交互 | 命令展开有独立事件，工具问答及权限反馈有独立路径；PreToolUse 执行在交互工具收集回答之前 | 仅装 UserPromptSubmit 不能作为交互问答、命令、恢复/压缩等输入已完整审核的证明，需要逐项验证或禁用未覆盖入口 |
| 本机落盘 | 官方明确表示被 hook 拒绝的提示仍可能出现在 transcript 和 prompt history | 原生 hook 不等同于 CC 聊天层的“拒绝后不持久化用户消息”；不得承诺被拒绝正文绝不落盘 |

官方 changelog 的 2.1.295 条目同时确认新增 `onFailure: "block"`；这是升级评估的最低版本条件，不是“升到该版就一定能恢复”的结论。隔离环境已下载并运行官方 2.1.295，生产没有升级。

## 已取得的隔离证据

VPS 实验目录为 `/var/lib/cc-native-hook-lab-2.1.295`。测试容器使用 `--network none`、只读文件系统和非 root 用户；没有挂载生产账号、配置、数据或服务目录。HTTPS 审核 stub 使用临时自签 CA 和固定假 token，模型 stub 使用假 API key；这些配置仅存在于实验容器内，不能带入生产。

| 实际测试 | 结果 |
| --- | --- |
| 官方 CLI 拒绝、多行输入、超时、崩溃、无效 JSON、缺少程序 | 被拒绝用例的模拟模型请求为 0；允许用例恰好到达模拟模型 1 次 |
| 普通 `disableAllHooks`、`--bare`、`--safe-mode` | 无法关闭受管拒绝策略 |
| 仅 `UserPromptSubmit` 的交互问答 | 已复现缺口：`AskUserQuestion` 的自由回答不再次触发普通提交审核 |
| 加入 `PostToolBatch`，运行实际审核适配代码 | 回答进入既有节点审核协议；拒绝回答未到达模拟模型 |
| `PreCompact` 与 `/compact` 附加说明 | 说明进入审核；被拒绝的压缩未到达模拟模型 |
| SDK 0.3.286 + 官方 CLI 2.1.295 | 既有 SDK 回调与 root 受管 hook 均运行，收到模拟响应；没有真实模型请求 |
| Linux 策略与权限校验 | root 管理的策略、程序、Node、CLI 和只读节点配置通过检查 |

官方 npm 包固定为 `@anthropic-ai/claude-code-linux-x64@2.1.295`，tarball SHA256 为 `d45a2fa14a7ea0b8ab4f56e502de5893c2b816078c71c4d8ab2e4142148f3d95`，准备脚本还校验固定 SHA512 SRI。没有修改官方二进制，也没有执行 npm 安装脚本。

## 候选实现与 Ubuntu 准备

`apps/server/src/native-moderation-hook.ts` 将官方事件转换为现有节点 API：普通提交对应 `message.send`，工具批次后的用户文本审核对应 `approval.reply`，压缩对应 `session.compact`。命令展开事件直接阻断。调用使用 command hook，不使用额外调用 Claude 的 prompt/agent hook；7.5 秒审核超时，无重试。仅明确允许才继续，其他情况返回通用阻断。

策略通过 `/etc/claude-code/managed-settings.json` 安装，每个事件包含 `onFailure: "block"`。实际 hook 从 `/etc/claude-code/moderation-node.json` 读取节点配置；未来激活时必须由管理员复制既有凭据后只读挂载到此路径，不能使用工作区可写文件作为终端的审核配置，也不重新领取或轮换凭据。管理员令牌和 JEV 密钥不进入镜像、命令行或新 CLI 环境变量。

`PROXY_NATIVE_TERMINAL_REVIEW=1` 是显式开关，默认关闭；还必须存在 native adapter、节点审核和通过校验的受管配置/固定 CLI。新开关本身不自动解禁。

`scripts/prepare-native-terminal-pilot.py --source <完整提交 SHA>` 仅为 `ubuntu-cc` 准备候选镜像，必须基于已验收的正式镜像 `sha256:c132c31b978f47bcf5783cf374b841eddd86d6eef343cca751426691406d6e24`。它会：

1. 固定公开源码，校验官方 CLI 包；发现已有受管配置时停止，避免覆盖既有政策。
2. 以 `--network none --pull=false` 构建 overlay，不安装依赖；保留 SDK、账号代码、原生终端实现、入口脚本和镜像运行设置。
3. 在无网络、无生产挂载的容器验证默认终端仍关闭、hook 故障阻断、实际 PTY 和 SDK 兼容；审核/模型接口都是容器内模拟服务。
4. 检查正式容器身份与健康未变，输出脱敏 `result.json`；结果明确为 `cutoverPerformed=false`、`activationReady=false`。

此脚本不停止服务、不启用新开关、不复制生产数据到测试容器。无需节点空闲或断开客户端。Ubuntu 候选镜像的实际构建/验证仍待用户执行，VPS 实验结果不能替代目标节点验证。

## 使用边界与尚待验证的路径

- 受管 hook 同时作用于 SDK 聊天，可能与现有聊天门禁重复审核；修正版还在每个工具批次审核用户文本，增加 JEV 延迟和用量。当前未做去重，也没有通过可伪造环境变量跳过受管审核。
- 原生审核会收集用户文本历史、交互回答及错误工具反馈；不把普通文件/工具输出全部送给 JEV。图片、文件上下文、管理员/直接 SSH、任意外部脚本不属于全面隔离范围。
- 官方可能保留已拒绝文本。再次审核全历史时，该文本可能继续导致拒绝；用户需新建会话或使用官方清理操作，不能通过偷偷修改官方 transcript 绕过审核。
- `PostToolBatch` 的通用拒绝提示可能保留在会话上下文，不能承诺 hook 完全不影响上下文；不发送 JEV 审核详情或策略解释给 Claude。
- 审核输入超过 64 KiB 或 transcript 超过 16 MiB 会拒绝，不静默截断。
- 权限反馈、排队追问、历史恢复需以修正版合并测试结果和 Ubuntu 补测结果为准；技能/命令展开采用明确阻断的限制。修正版尚未在目标节点验收前不能激活。JEV→真实 Claude 的完整链路也未验收，不会自动发送真实测试。

没有更改账号、代理、出口、OAuth、遥测或模型重试配置。使用官方接口并不能推断账号风控概率为零，也无法给出升级前后概率的保证。

## 后续可验证方案

沿用官方原生 CLI 和模型通信，不改二进制、不代理 Claude 请求，不增加遥测或模型重试。只使用官方 **command hook** 调用既有关键词/JEV 审核，不使用需要额外 Claude 调用的 prompt/agent hook。仅明确允许时继续；拒绝与服务故障都停止，用户侧只显示通用失败，不发送审核详情到模型上下文。

节点凭据继续由服务端保管，不把管理员密码、JEV 密钥或节点令牌放入 hook 命令行、普通设置文件或新增 CLI 环境变量。可评估让 hook 通过本机受控接口复用现有审核服务；当前远端节点 API 的响应 `{id, allowed}` 也不能直接当作官方 hook 决策 JSON 使用，必须明确转换。

恢复前的必要证据：

1. 在无账号、无生产数据的隔离环境，使用固定且具备 `onFailure` 的官方版本验证允许、拒绝、超时、程序缺失、崩溃及无效输出。只用模拟审核和无害输入；拒绝测试不能到达模型请求阶段。
2. 验证普通配置或会话内开关不能关闭受管审核；执行用户不能修改审核程序或受管策略。保留现有合法配置，不能为图省事直接开启 `allowManagedHooksOnly` 后悄悄移除用户原有 hook。
3. 验证普通输入、多行粘贴、排队追问、问题回答、权限反馈、技能/命令、恢复及压缩路径。没有可靠提交前检查的入口必须限制，不能用事后日志代替。
4. 记录新版与当前版本的实际配置/网络差异及回退方式，通过后才评估生产切换。CLI 升级不能夹带在本次“修复终端”中，也不能承诺官方功能或升级保证账号零风控。

已完成的证据见前表，尚未完成的路径仍是正式恢复条件。当前电脑没有 ubuntu-cc SSH 管理通道，候选准备需要用户在现有 Ubuntu 终端执行。生产没有移除 `moderation_terminal_disabled`。受管策略不构成对宿主机管理员、直接 SSH 或所有外部文件内容的全面隔离。

## 官方依据

以下官方页面于评估日读取；文档会变化，隔离实现时仍须核对目标固定版本的实际行为。

- [UserPromptSubmit](https://code.claude.com/docs/en/hooks#userpromptsubmit)：提交前事件、超时行为及被拦截提示的本机存储说明。
- [Block the action when a hook fails](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails)：`onFailure` 的行为与最低版本。
- [Disable or remove hooks](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks)：受管 hook 与普通配置开关的关系。
- [Deploy managed settings](https://code.claude.com/docs/en/managed-settings)：系统路径、策略来源与生效规则。
- [官方 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)：2.1.295 新增 `onFailure: "block"`。
- [本项目节点门禁验收](MODERATION-NODE-GATE.md)：当前生产镜像与客户端三项验收结果。
