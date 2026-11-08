# Claude 调用、网络与完整性检查

2026-11-05（香港时间）。用户要求检查当前 CC Space 是否在远端调用 Claude、是否从远端网络出站，以及有无修改 Claude Code、绕过规则或不符合官方要求的行为。

## 范围与结论

检查当前主分支 `1ee2559`、本地生成且已发布的 Windows Build 29（包内源码 `25cb477603ae05d3997d0fcf45967affa519df5e`）、官方 npm 包元数据及 SDK 实际文件，并只读查询管理中心节点版本。未启动真实 Claude、执行账号登录、查询真实额度、发送真实模型/JEV 请求或更改任何生产配置。

**代码与制品证据支持：** 产品的聊天模型调用、原生 Claude 终端和账号状态读取在 Ubuntu 服务端；未发现桌面新增模型运行路径、上传 Claude OAuth token 给管理中心、自动换号绕额度、修改官方 CLI 的当前正常安装流程或关闭模型内容安全机制的实现。

**不能据此证明：** 实际公网出口一定属于远端宿主机；每台当前运行中的 CLI 和 SDK 都已经在本轮逐字节读取核验；整套产品使用订阅登录和 Agent SDK 已得到 Anthropic 许可。上述结论不能写成“完全符合所有规则”或“账号绝无风险”。

## 1. Claude 的执行位置

| 证据 | 观察 |
| --- | --- |
| `apps/server/src/claude.ts` | 通过官方 Agent SDK `query()`，指定 `pathToClaudeCodeExecutable`；SDK 调用在服务端，Windows 原生 adapter 被拒绝。也包含不提交模型提示词的原生状态读取 |
| `apps/server/src/native-terminal.ts` | 服务端 node-pty 启动配置的 Claude CLI；桌面提供终端界面和输入输出，未在桌面启动 Claude |
| `apps/server/src/server.ts`、`native-account.ts` | 当前账号入口除状态读取外拒绝远程登录/退出等操作，要求在 Ubuntu 管理。状态通过官方 `auth status --json` 读取；旧登录类虽保留在模块中，当前入口不调用 |
| `apps/server/src/native-deployment.ts` | 受管部署固定 `/opt/runtime/cli/bin/claude`，检查管理员策略和只读挂载；普通 service.env 不能关闭受管准入 |
| 桌面依赖与实际 app.asar | 模型运行依赖静态检查通过；实际 Windows Build 29 的包清单未发现 Anthropic/OpenAI 模型 SDK/CLI 包路径 |
| SSH 目标 | 本机转发 exec/SFTP，不把模型 SDK、provider 凭据或 Claude 运行时分发到开发目标；附加提示明确模型流量属于服务端 |

这里的“拒绝 Windows adapter”只是一项保护，不单独证明程序一定跑在指定 Ubuntu。完整位置依据是受管部署、调用层次及实际客户端制品共同确定；静态导入检查也不是 OS 网络沙箱。

## 2. 模型网络出口：符合架构，实际线路仍待核对

服务端 SDK 与 CLI 继承服务端环境和配置，桌面的系统代理用于 CC 控制、更新及连接；未发现把模型 HTTP 请求交给本机 CC Space 发送的专门实现。

但 `process.env` 和 provider/settings 的 `env` 可包含 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`、`ANTHROPIC_BASE_URL` 等。远端配置若指向别的代理，实际线路也会改变；运行位置在 Ubuntu 并不自动等于公网 IP 属于 Ubuntu。

现有部署维护手册第 4 节记载的是 **Ubuntu 容器 → 远端 Windows 宿主网络 → 模型服务**，VPS 主要中转 CC 控制连接。这与“本机 CC Space 不代发模型请求”可以同时成立，不能把远端 Windows 宿主和用户当前开发电脑混为一谈。该历史描述不是本轮抓包证据。

本轮只读管理接口确认 `ubuntu-cc`、`ubuntu-cc-02`、`ubuntu-cc-03` 在线，均为 Build 14 / 协议 24，最近 Build 14 作业 succeeded；这证明报告的升级状态，不直接证明当前网络配置和模型出站 IP。需要进一步只读核对各节点 Docker 网络、CLI 实际进程环境、service.env/provider/settings 中的路由项、远端宿主 VPN/NAT，输出脱敏结果；真实模型流量应在用户正常使用时观察，不能拿普通 curl 的 IP 代替 Claude 专用代理链路。

## 3. CLI 与 SDK 是否被修改

### 当前安装与更新路径

`scripts/install-linux.sh` 固定官方原生 Claude Code 2.1.295，从 `registry.npmjs.org/@anthropic-ai/claude-code-linux-x64` 或 arm64 包下载，核对固定 SHA512 后提取并安装原生文件。当前常规 Dockerfile 和宿主机迁移没有对 CLI 做二进制补丁；迁移另核对 x64 官方 CLI SHA256 `4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`。

本次在线读取官方 npm x64 2.1.295 元数据，其归档 SHA512 与安装脚本固定值一致。没有重新下载 256 MB 解压后的 CLI，也没有直接读取三台 Ubuntu 的当前二进制，不能将元数据核对写成各台实时完整性扫描。

SDK 固定 0.3.286，lock 中下载 URL 和 SHA512 与官方 npm 元数据一致。本次下载并验证官方 SDK 归档 SHA512，再与本地 `node_modules/@anthropic-ai/claude-agent-sdk` 比较，**19 个文件全部一致，无差异**。仓库补丁目录只有 micromark 说明，未见 Anthropic 包补丁。本地 SDK 结果不自动覆盖各生产容器内的 SDK 文件。

### 历史异常必须保留说明

[2026-10-24 核对记录](CLAUDE-COMPLIANCE-REVIEW-2026-10-24.md) 记载首台实际 CLI 曾与官方 2.1.295 文件相差 1 字节，实际 SHA256 为 `f66a66b89fa1c229ff9edce0065277a2d0897ebd6710f6d3e8b722c6e1d9ec2e`，原因未知，不能据此断言恶意修改、无害差异或由审核 Hook 导致。其后用户回传官方文件恢复及 SHA256 核验成功。`restore-reviewed-claude-cli.py` 是针对该历史固定身份的恢复脚本，不是当前安装路径中的补丁工具。

准确表述是“当前受审安装流程使用固定官方文件，历史有差异和恢复记录”，不能说“从未有过二进制差异”。

## 4. 自定义行为与规则边界

| 行为 | 当前实现与判断 |
| --- | --- |
| 远程执行系统提示 | 使用 `claude_code` preset 并追加 SSH/工作目录/断线处理指令；原生终端使用 `--append-system-prompt`。这会影响行为，不是修改 CLI，也未发现要求忽略 Anthropic 安全规则的文字 |
| 管理员审核 | 额外的 `UserPromptSubmit` command Hook，以及 SDK 输入前的消息审核。会向管理中心审核接口发送用户新消息，允许/拒绝后才继续。属于额外拦截，不等于替换模型接口或取消原有安全机制；也不能声称输入只发 Anthropic、没有其他处理方 |
| 工具权限 | 支持用户选择 `bypassPermissions`；只有该模式才设置 SDK 的 `allowDangerouslySkipPermissions`。桌面偏好默认不开启绕过选项。它跳过工具操作审批，不能称为绕过模型内容安全；对用户文件和命令执行有实际风险，应保留显式选择与现有审批模式 |
| 原生设置与全局说明 | 通过现有设置入口编辑 Ubuntu 的 Claude settings、`CLAUDE.md`，设置会话历史保留期。是明确的自定义行为，不是“完全没有修改任何配置”；不是修改官方二进制 |
| 首次引导 | `native-onboarding.ts` 存在读取凭据存在性并写 `hasCompletedOnboarding` 的旧辅助函数；当前 `apps/server/src` 搜索未发现生产调用点，仅保留定义。不能误报为当前启动必然执行，也不能说模块从未接触凭据 |
| 用量遥测 | 开启 CLI 的 OTEL 日志导出至 Ubuntu 进程内回环 collector，不是本机桌面模型代理；新初始化还使用关闭官方遥测/错误上报/后台更新的配置项。固定版本需管理员维护，不能据此保证账号合规 |
| 被动账号监控 | 消费已存在的状态和用量数据，向管理中心报告账号邮箱/套餐等元数据。不是模型请求中转；仍是额外的数据处理方，不能描述为账号信息绝不离开 Ubuntu |

官方工具权限选择、自定义指令、command Hook 与模型自身安全政策是不同层次。本轮没有找到伪造认证、自动换号绕额度或重写模型回复的对应正常调用路径；没有替用户移除上述额外审核或修改权限设置。

## 5. 官方条款判断的限度

需要分别核对“官方未修改 CLI 由本人订阅登录”与“自定义产品通过 Agent SDK 使用订阅凭据”的适用范围。此前报告已将该组合的许可列为未决事项；本轮不能仅因本人使用、二进制验真或测试通过，就认定整个组合得到许可。

本轮尝试读取 Anthropic 官方 [法律与合规](https://code.claude.com/docs/en/legal-and-compliance)、[网络配置](https://code.claude.com/docs/en/network-config)及 [Agent SDK 概览](https://platform.claude.com/docs/en/agent-sdk/overview)，遭遇 HTTP 403/连接错误；未把不可访问页面或旧报告当作最新条款确认。官方 npm 制品元数据可以访问，并已用于完整性验证。

因此，“未发现当前修改官方文件或绕过认证/模型安全机制的实现”是本次工程检查结论；“完全符合全部当前服务条款”没有足够依据。不能预测或保证账号后续不会被限制。

## 6. 本轮证据与后续

- `node scripts/check-model-boundary.mjs` 通过。
- Build 29 实际 app.asar 核对包内身份与模型包路径；未启动本机 Claude。
- 官方 npm SDK 归档完整性与本地 19 文件比较通过；CLI 下载归档固定摘要与官方元数据一致。
- 59 项模型边界、受管部署、配置、原生审核、设置、终端、Tunnel 相关测试通过，均为隔离/受控测试，不调用真实模型。
- 只读管理接口确认三台节点 Build 14 succeeded，未启动新更新任务或账号操作。
- 尚缺实际节点进程/文件/配置的本轮只读快照及用户正常使用时的模型连接观察；不能以管理中心在线、普通出口探测或历史报告代替。

本轮仅新增报告，不修改应用、SDK、CLI、账号、权限、代理或生产部署。
