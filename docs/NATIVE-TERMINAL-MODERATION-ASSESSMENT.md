# 原生终端强制审核可行性评估

评估日期：2026-10-23（香港时间）。用户选择保留强制审核，先评估官方支持方式，确认可行后才恢复。

结论：官方 **2.1.295** 的受管 command hook 已完成部分真实 CLI/PTY 隔离验证，候选实现和 Ubuntu 离线准备脚本已完成。生产仍是 **2.1.293**，原生终端继续关闭；权限反馈、排队输入、技能及恢复路径尚未完成实际验证，**目前不能切换生产或宣称全面覆盖**。本轮真实 Claude/JEV 请求均为 0，模拟请求仅到达无网络容器内的 loopback stub。

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

`apps/server/src/native-moderation-hook.ts` 将四个官方事件转换为现有节点 API：普通提交/命令展开对应 `message.send`，交互回答对应 `approval.reply`，压缩对应 `session.compact`。调用使用 command hook，不使用额外调用 Claude 的 prompt/agent hook；7.5 秒审核超时，无重试。仅明确允许才继续，其他情况返回通用阻断。

策略通过 `/etc/claude-code/managed-settings.json` 安装，每个事件包含 `onFailure: "block"`。实际 hook 从 `/etc/claude-code/moderation-node.json` 读取节点配置；未来激活时必须由管理员复制既有凭据后只读挂载到此路径，不能使用工作区可写文件作为终端的审核配置，也不重新领取或轮换凭据。管理员令牌和 JEV 密钥不进入镜像、命令行或新 CLI 环境变量。

`PROXY_NATIVE_TERMINAL_REVIEW=1` 是显式开关，默认关闭；还必须存在 native adapter、节点审核和通过校验的受管配置/固定 CLI。新开关本身不自动解禁。

`scripts/prepare-native-terminal-pilot.py --source <完整提交 SHA>` 仅为 `ubuntu-cc` 准备候选镜像，必须基于已验收的正式镜像 `sha256:c132c31b978f47bcf5783cf374b841eddd86d6eef343cca751426691406d6e24`。它会：

1. 固定公开源码，校验官方 CLI 包；发现已有受管配置时停止，避免覆盖既有政策。
2. 以 `--network none --pull=false` 构建 overlay，不安装依赖；保留 SDK、账号代码、原生终端实现、入口脚本和镜像运行设置。
3. 在无网络、无生产挂载的容器验证默认终端仍关闭、hook 故障阻断、实际 PTY 和 SDK 兼容；审核/模型接口都是容器内模拟服务。
4. 检查正式容器身份与健康未变，输出脱敏 `result.json`；结果明确为 `cutoverPerformed=false`、`activationReady=false`。

此脚本不停止服务、不启用新开关、不复制生产数据到测试容器。无需节点空闲或断开客户端。Ubuntu 候选镜像的实际构建/验证仍待用户执行，VPS 实验结果不能替代目标节点验证。

## 使用边界与尚待验证的路径

- 受管 hook 同时作用于 SDK 聊天，可能与现有聊天门禁重复审核，增加 JEV 延迟和用量；当前未做去重，也没有通过可伪造环境变量跳过受管审核。
- 原生审核会收集用户文本历史、交互回答及错误工具反馈；不把普通文件/工具输出全部送给 JEV。图片、文件上下文、管理员/直接 SSH、任意外部脚本不属于全面隔离范围。
- 官方可能保留已拒绝文本。再次审核全历史时，该文本可能继续导致拒绝；用户需新建会话或使用官方清理操作，不能通过偷偷修改官方 transcript 绕过审核。
- `PostToolBatch` 的通用拒绝提示可能保留在会话上下文，不能承诺 hook 完全不影响上下文；不发送 JEV 审核详情或策略解释给 Claude。
- 审核输入超过 64 KiB 或 transcript 超过 16 MiB 会拒绝，不静默截断。
- 真实权限反馈、排队追问、技能/命令展开及恢复路径尚未全部验证；仍须逐项验证或限制后才可评估激活。JEV→真实 Claude 的完整链路也未验收，不会自动发送真实测试。

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
