# JEV 接口核对与 CC 实施进度

2026-10-23。用户指定参考 `Wei-Shaw/sub2api`，并明确选择：**关键词命中直接拦截，其余消息全部交给 JEV**。

## 已核对的来源

参考仓库固定在提交 `8286268047cbbca4e7f5fbb63ff0890c1ea37cf5`，避免以后默认分支变化造成误解：

- [原生 TypeSafe 请求和响应校验](https://github.com/Wei-Shaw/sub2api/blob/8286268047cbbca4e7f5fbb63ff0890c1ea37cf5/backend/internal/pkg/typesafe/client.go)
- [JEV 文本审核及 13 个分类](https://github.com/Wei-Shaw/sub2api/blob/8286268047cbbca4e7f5fbb63ff0890c1ea37cf5/backend/internal/service/content_moderation_typesafe.go)
- [关键词模式、同步检查及失败处理](https://github.com/Wei-Shaw/sub2api/blob/8286268047cbbca4e7f5fbb63ff0890c1ea37cf5/backend/internal/service/content_moderation.go)
- [管理员审核配置接口](https://github.com/Wei-Shaw/sub2api/blob/8286268047cbbca4e7f5fbb63ff0890c1ea37cf5/backend/internal/handler/admin/content_moderation_handler.go)
- [TypeSafe 官方 OpenAPI](https://api.typesafe.ai/openapi.json)，本次只读取公开文档，没有调用审核模型。

sub2api 的 TypeSafe 适配器是原生 JEV 内容分类。仓库内另一套 prompt-audit 扫描器采用不同接口，不应混为一谈。本项目根据公开接口独立编写 TypeScript 实现，没有引入 sub2api 的 Go 服务或运行时依赖；CC 的分类问题单独编写并使用独立版本号。

## 实际接口

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <server-side-key>
Content-Type: application/json
```

```json
{
  "model": "jev-latest",
  "state": "待审文本",
  "questions": {
    "sexual": {"type": "noul", "instructions": "分类判断问题"}
  }
}
```

```json
{
  "model": "jev-actual-version",
  "answers": {"sexual": {"type": "noul", "noul": 0.1}},
  "usage": {"input_tokens": 120, "output_tokens": 12}
}
```

当前规则 `cc-text-18-v2` 保留原有 13 分类，并增加政治与公共安全危害、恐怖极端与危险行为、色情低俗诱导、违法犯罪与赌博、欺凌诱导与隐私侵犯五组。用户已明确：只拦截有害请求，允许中立新闻、历史学习、合法批评、科普与求助；不因政治观点、宗教或主题词本身判定违规。原分类阈值保留，新增分类初值 0.5；升级自动增加缺失分类并递增策略版本、记录迁移，保留密钥和其他设置。实际校准与生产采用值以部署记录为准。

响应中每个分类必须存在、类型为 `noul`、分数为有限的 0–1 数值，且必须包含模型名。任一分类缺失都视为接口错误，不能以零分处理。分数达到配置阈值即命中；`noul` 是模型认为对应问题答案为“是”的分数，不是经过业务校准的违规概率。低阈值会增加拦截和误判。

## 策略差异

| 模式 | 关键词命中 | 未命中 |
| --- | --- | --- |
| `keyword_and_api`（用户选定，CC 默认） | 直接拦截，不调用 JEV | 调用 JEV |
| `keyword_only`（sub2api 支持） | 直接拦截 | 直接放行 |
| `api_only`（sub2api 支持） | 不使用关键词，调用 JEV | 调用 JEV |
| `keyword_triggered_jev`（此前讨论方案，CC 可选） | 调用 JEV | 直接放行 |

关键词采用忽略大小写的子串匹配，不承诺规避变体检测。直接拦截模式也会拦截引用或代码中出现的词条。

sub2api 的同步审核在缺少 API 密钥或模型调用失败时会返回允许。本项目按此前需求采用另一种处理：**凡必须经过 JEV 的请求，缺少密钥、超时、HTTP 错误、无效响应均返回审核失败，不放行**。关键词直接拦截路径不依赖 JEV 可用性。

## 本次已实现：管理配置与审核内核

代码位于现有 `apps/update-service`，管理入口继续使用 `/cc-updates/admin/`，复用管理员密码登录、兼容令牌、Origin 校验及退出流程。管理模块已于 2026-10-23 部署，运行源码为 `4e3ce9d`，详见 [上线记录](MODERATION-ADMIN-INTEGRATION.md#上线记录)。

- `src/jev.ts`：TypeSafe 原生文本请求、18 分类问题、响应校验、超时、1 MiB 响应上限。单次请求，不自动重试；默认 5 秒。错误只保留稳定原因码，不保存服务商错误正文。
- `src/moderation.ts`：四种策略、配置版本冲突检查、私有 SQLite 配置和操作记录。默认采用用户选定的 `keyword_and_api`，初始关键词为空、API 密钥未配置。
- 网页“内容审核”：策略、JEV 配置、阈值、文本试算、记录；与客户端更新共用登录。文本试算使用已保存策略；需要 JEV 时会发送文本并可能计费，不会自动触发。
- 管理 API：`GET/PUT /cc-updates/admin/api/moderation/config`、`GET .../events`、`POST .../preview`。这些是管理员接口，不提供节点认证。
- 配置读取仅返回 `apiKeyConfigured`，不回显密钥。保存时 `apiKey: null` 保留、空字符串删除，其他字符串替换。密钥只存在服务私有目录 `private/moderation.sqlite`，目录由既有服务设为 0700，数据库设为 0600；不使用签名私钥或续期进程保存 JEV 密钥。
- 保存策略与对应配置操作记录在同一事务中提交。试算记录包含请求 ID、管理员、策略版本、规则版本、分数、结论、稳定错误原因、耗时及文本 SHA-256/字节数，不保存原始文本。关键词命中词条仍会记录。
- 记录默认保留 7 天，可设 1–90 天，启动及保存、试算、读取记录时清理过期项；网页最多显示最近 100 条。保留时间不是按时物理擦除承诺。
- 包装脚本已将新增模块纳入显式运行文件清单。

**本次没有启用 CC 生产消息拦截。** 管理接口明确返回 `enforcement: not-connected`，页面也说明节点尚未接入。模拟接口测试通过不代表 JEV 真实账号、费用、分类效果或生产节点链路已经验收。

本地验证：JEV 适配器、策略、持久化与管理 HTTP 核心测试共 11 项通过；同登录下更新发布/撤回与审核配置/试算的真实浏览器测试 1 项通过，覆盖桌面和手机布局、纯文本渲染及退出清理。TypeScript 类型检查、代码格式及 diff 检查通过。浏览器测试未配置 JEV 密钥，模型适配器测试仅使用本地模拟 HTTP/响应，没有生产模型请求。

## 下一实施段：CC 服务端执行前检查

在 `apps/server/src/server.ts` 的 `submit()` 中，必须在持久化用户消息、提交 NativeInput 或启动新 run 之前完成审核。覆盖普通发送、排队发送、已有 run 输入以及继续、压缩操作；不能只拦截创建新 run 的分支。

实施要求：

1. 节点到 VPS 使用单独的节点凭据。管理员令牌、JEV 密钥和更新签名私钥不下发 CC 节点。新增节点接口需要精确的 Nginx location；现有 `/cc-updates/` 兜底为 404。
2. `submit()` 改为异步并由 `execute()` 等待。沿用现有请求去重，并在等待审核后重新检查会话、工作区和 run 状态；同一会话的提交要保持顺序，防止并行审核造成重复 run 或输入乱序。
3. 拒绝或调用失败必须结束客户端操作并返回通用错误；原因和关联 ID 留给管理员，不把审核结论详情传到普通客户端。
4. `AskUserQuestion` 回答也是模型输入，需要在进入 `updatedInput.answers` 前检查。`run.continue` 与 `/compact` 涉及既有上下文，单独检查固定命令文本不代表重新审核完整历史。
5. 原生 PTY 可直接输入官方 CLI，不能用逐行拼接键盘事件冒充提示词审核。正式强制模式必须明确选择限制原生终端，或实施经过验证的 CLI 输入钩子。未解决前不能声称不可绕过。
6. 工作区文件、图片、工具输出及指令/配置修改也可能进入模型上下文。第一版文本审核不覆盖这些内容，不应宣传为完整模型上下文审查。
7. 先用模拟管理服务验证通过、关键词拦截、JEV 拦截、超时、节点断连、重复请求、已有 run 输入和会话状态变化，再在 ubuntu-cc 试点。其余五台继续暂缓。

VPS 更新通道、发布版本以及自动续期没有因本次开发而切换；真实 JEV 密钥和生产模型测试仍未使用。

## JEV 使用量

管理员 `GET /cc-updates/admin/api/moderation/usage` 返回本服务统计起始时间、实际尝试请求数、审核错误数、已报告及未取得用量的请求数，以及输入/输出/合计 Token。页面在进入审核分区、刷新和试算后更新。累计独立保存在 `usage_totals`，不因审核记录保留期清理或服务重启而归零；不回填旧版未保存的用量，也不包含其他应用调用。

有效响应的 `usage.input_tokens`、`output_tokens` 仅接受非负安全整数，即使分类响应无效但用量有效也累计。无密钥及关键词直接拦截没有实际 API 请求，不计入；超时、HTTP 错误或缺失用量记录为未取得用量，不能当作免费。请求统计和对应审核记录同事务提交，统计不暴露密钥或原文。

2026-10-23 核对官方实时 OpenAPI，仅公开 `/v1/models` 与 `/v1/systemone`，未提供余额接口。返回的剩余 Token/余额为 `null`，网页链接到官方确认的 [TypeSafe 控制台](https://console.typesafe.ai/)，不把本地 Token 总数冒充服务商余额。具体价格、账单、其他应用与超时请求的计费均以服务商为准。
