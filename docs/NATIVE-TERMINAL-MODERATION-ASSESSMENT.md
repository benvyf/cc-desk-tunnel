# 原生终端强制审核可行性评估

评估日期：2026-10-23（香港时间）。用户选择保留强制审核，先评估官方支持方式，确认可行后才恢复。

结论：存在官方实现方向，但当前固定 Claude Code **2.1.293** 不满足严格故障阻断条件，不能直接恢复原生终端。生产配置、镜像、CLI、账号与出网不变，继续使用已经验收的聊天审核门禁；本次只有文档和源码阅读，没有 Claude/JEV 请求，也没有运行 CLI。

## 官方支持与当前版本差异

| 项目 | 官方行为 | 对本项目的影响 |
| --- | --- | --- |
| `UserPromptSubmit` | 在处理用户提示前执行，可用 `decision: "block"` 或退出码 2 拒绝 | 可作为终端普通文本的审核入口，不能仅凭事件名宣称全部输入覆盖 |
| 异常与超时 | 默认多数 hook 失败后仍执行原操作；UserPromptSubmit 超时后提示仍可到达 Claude | 当前版本不能把 hook 的正常拒绝当成审核程序故障时也会拒绝 |
| `onFailure: "block"` | command/http hook 的启动失败、异常退出、超时、无效 JSON 等可阻断；要求 **2.1.295 及以上** | 当前 2.1.293 不具备该受支持选项；不能写入新字段并假设它生效 |
| 受管审核 hook | managed policy 中的 hook 不被普通 user/project/local 的 `disableAllHooks` 关闭；Linux 系统文件为 `/etc/claude-code/managed-settings.json` | 普通 settings.json 或临时 `--settings` 中的 hook 不足以承担强制策略；需要管理员拥有、执行用户不可写的受管配置与审核程序 |
| 原生交互 | 命令展开有独立事件，工具问答及权限反馈有独立路径；PreToolUse 执行在交互工具收集回答之前 | 仅装 UserPromptSubmit 不能作为交互问答、命令、恢复/压缩等输入已完整审核的证明，需要逐项验证或禁用未覆盖入口 |
| 本机落盘 | 官方明确表示被 hook 拒绝的提示仍可能出现在 transcript 和 prompt history | 原生 hook 不等同于 CC 聊天层的“拒绝后不持久化用户消息”；不得承诺被拒绝正文绝不落盘 |

官方 changelog 的 2.1.295 条目同时确认新增 `onFailure: "block"`；这是升级评估的最低版本条件，不是“升到该版就一定能恢复”的结论。本次没有对生产或隔离 CLI 执行升级。

## 后续可验证方案

沿用官方原生 CLI 和模型通信，不改二进制、不代理 Claude 请求，不增加遥测或模型重试。只使用官方 **command hook** 调用既有关键词/JEV 审核，不使用需要额外 Claude 调用的 prompt/agent hook。仅明确允许时继续；拒绝与服务故障都停止，用户侧只显示通用失败，不注入审核内容、结论或提示词到模型上下文。

节点凭据继续由服务端保管，不把管理员密码、JEV 密钥或节点令牌放入 hook 命令行、普通设置文件或新增 CLI 环境变量。可评估让 hook 通过本机受控接口复用现有审核服务；当前远端节点 API 的响应 `{id, allowed}` 也不能直接当作官方 hook 决策 JSON 使用，必须明确转换。

恢复前的必要证据：

1. 在无账号、无生产数据的隔离环境，使用固定且具备 `onFailure` 的官方版本验证允许、拒绝、超时、程序缺失、崩溃及无效输出。只用模拟审核和无害输入；拒绝测试不能到达模型请求阶段。
2. 验证普通配置或会话内开关不能关闭受管审核；执行用户不能修改审核程序或受管策略。保留现有合法配置，不能为图省事直接开启 `allowManagedHooksOnly` 后悄悄移除用户原有 hook。
3. 验证普通输入、多行粘贴、排队追问、问题回答、权限反馈、技能/命令、恢复及压缩路径。没有可靠提交前检查的入口必须限制，不能用事后日志代替。
4. 记录新版与当前版本的实际配置/网络差异及回退方式，通过后才评估生产切换。CLI 升级不能夹带在本次“修复终端”中，也不能承诺官方功能或升级保证账号零风控。

本轮尚不具备上述隔离运行证据；当前电脑也没有 ubuntu-cc SSH 管理通道。因此没有移除 `moderation_terminal_disabled`，没有让用户重新构建或切换生产。受管策略也不构成对宿主机管理员、直接 SSH 或所有外部文件内容的全面隔离。

## 官方依据

以下官方页面于评估日读取；文档会变化，隔离实现时仍须核对目标固定版本的实际行为。

- [UserPromptSubmit](https://code.claude.com/docs/en/hooks#userpromptsubmit)：提交前事件、超时行为及被拦截提示的本机存储说明。
- [Block the action when a hook fails](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails)：`onFailure` 的行为与最低版本。
- [Disable or remove hooks](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks)：受管 hook 与普通配置开关的关系。
- [Deploy managed settings](https://code.claude.com/docs/en/managed-settings)：系统路径、策略来源与生效规则。
- [官方 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)：2.1.295 新增 `onFailure: "block"`。
- [本项目节点门禁验收](MODERATION-NODE-GATE.md)：当前生产镜像与客户端三项验收结果。
