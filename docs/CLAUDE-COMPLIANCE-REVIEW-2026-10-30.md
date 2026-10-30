# Build 8 服务端 Anthropic 条款复查

检查日期：2026-10-30（香港时间）。结论：**不能认定当前服务端整体符合 Anthropic 条款；自定义聊天的 SDK 认证边界仍需整改或取得明确许可。** 这不等于已证明账号违约或已被 Anthropic 判定违规。

## 范围与证据

用户已确认第一台、02、03 均升级成功至 Linux Build 8 / protocol 22。检查本地实际发布包 `.local/release-20261029/cc-desk-tunnel-server-0.3.7-build8.tar.gz`，描述符源码为 `6e287825154d5e82e29430881e132b689642b7c5`。其中 `claude.ts`、`server.ts`、`native-account.ts`、`native-terminal.ts`、`moderation.ts`、`native-terminal-policy.ts` 六份服务端文件与当前 main 的对应文件逐字节摘要一致。因此下述关键发现适用于这份 Build 8 制品，并非只针对未来源码。

没有直接读取三台 Ubuntu 的当前进程、环境变量或账号凭据；不能据此确认实际生效的 provider、套餐、API key 是否覆盖订阅认证、CLI 当前二进制或所有历史用途。依据用户此前确认的本人自用、本人账号、不向其他邮箱开放节点、人在马来西亚进行判断。此次未调用 Claude、未改变认证或计费、未修改运行代码或生产配置。

## 主要发现

1. **自定义聊天仍有认证合规缺口。** `apps/server/src/claude.ts:165` 的 `runClaude()` 调用官方 Agent SDK `query()`，指定 CLI，并继承进程环境及自定义环境；没有单独强制 API / 支持云认证。`:486` 的 `readNativeStatus()` 也会启动 SDK，不能只整改发送消息入口。官方登录成功、调用官方 CLI 和本人自用，均不足以单独证明自建 SDK 界面使用个人订阅获准。

   官方法律页要求开发自建产品或服务（包括 Agent SDK 集成）使用 API key 或支持的云服务，禁止第三方向自己的应用提供 Claude.ai 登录或代用户通过 Free/Pro/Max 凭据路由请求。SDK 概览要求事先批准，否则不得为产品提供 Claude.ai 登录或额度。法律页同时提及普通个人使用 Claude Code/Agent SDK 的限额假设；不能忽略这一表述，也不能将其扩大为所有自定义 SDK 集成都获准。**本项目纯个人自托管的订阅 SDK 用法，应列为许可未明确，不能直接断言已获许可或已确定违约。** 若实际是本人合法 API / 云认证，则应按实际配置收窄结论。

2. **原生终端不应与自定义聊天混为一谈。** `native-terminal.ts` 以 PTY 启动配置的 CLI，使用正常 CLI 参数；未在受审路径发现因多标签增加账号轮换、绕过订阅额度或改写官方二进制的实现。官方法律页明确允许最终用户在未修改的 Claude Code 中使用本人订阅；产品托管 CLI 另须满足商业条款、不修改二进制或限制其内置认证、不代付/转售/中转用户用量等条件。仅凭远程终端、多标签、备份或更新本身，没有发现新增禁用机制的依据。这不是对真实节点二进制和所有用途的全面认证。

3. **当前账号入口拒绝 CC 代办登录。** `server.ts:701` 附近的 `account()` 只接受状态查询；登录、授权码、退出等操作返回“请在 Ubuntu 终端使用官方 Claude Code”。`native-account.ts` 仍有历史 `NativeLogin` 实现，但该服务端入口没有调用它。用户曾使用官方授权链接，不代表当前自定义聊天另获订阅集成许可，也不能仅凭历史 helper 的存在认定它正在收集凭据。

4. **定时任务与后台读取必须一并考虑。** 自定义聊天、定时发送最终进入同一 SDK 调用链；认证整改不能仅隐藏聊天输入框。后台状态没有发送模型提示词，也不能被描述为纯本地离线读取。本次未读取私人任务文件，不认定用户已使用未经许可的无人值守任务。

5. **审核与认证授权是两回事。** 原生审核 hooks 有失败阻断，`moderation.ts` 会把待审文本发送到配置的审核服务；账号监控会发送白名单账号元数据。没有在本次受审路径发现新增上传 Claude OAuth token 的实现，但审核数据并非全部只留在 Ubuntu，须按实际配置处理隐私和内容权利。自建审核通过不等于 Anthropic 对认证集成或具体用途授权。

6. **马来西亚不是当前已发现的地区问题。** 本次读取官方访问地区帮助页，包含 Malaysia；不能仅根据 VPS 所在地或出口推定用户实际资格。内容用途仍须遵守有效 Usage Policy。

## 最小处置建议

- 保留本人通过未修改官方 CLI 使用的原生终端路径；不共享订阅账号，不轮换账号规避限额。
- 自定义聊天若继续使用，明确采用本人 API key / 支持云认证，或先取得覆盖该个人自托管 SDK/订阅架构的明确许可。实际配置尚未核实前，不宣称它已合规，也不直接判定已违规。
- 如实施整改，在服务端最终 SDK 边界同时覆盖聊天、状态查询、定时任务；费用变化须明确告知，不能静默切换到收费 API。此次仅检查，未执行这些变更。

## 本次重新读取的官方来源

- [Claude Code 法律与合规](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)：认证限制及本人使用原生 CLI 的例外；同页的产品托管条件需要同时阅读。
- [Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)：事先批准及 API 认证要求。
- [消费者条款](https://www.anthropic.com/legal/consumer-terms)：页面标注 2025-10-08 生效；账号共享、非明确允许的自动化访问等约束。
- [官方访问地区帮助](https://support.claude.com/en/articles/8461763-where-can-i-access-claude)：包含 Malaysia。
- [Usage Policy 展示页](https://www.anthropic.com/legal/aup)：本次仍显示 2026-11-12 生效，晚于检查日，不能当成今天已生效文本。此前报告记录的历史有效版本见 [2026-10-29 复查](CLAUDE-COMPLIANCE-REVIEW-2026-10-29.md)；此次未抽查私人内容，也未重新完成全部内容用途条目的逐项核对。

原文及 SHA256 清单保存在本机 `.local/compliance-review-2026-10-30/`。本报告对照代码、制品与可获取的官方文字，不能替代 Anthropic 对特定架构的授权确认。
