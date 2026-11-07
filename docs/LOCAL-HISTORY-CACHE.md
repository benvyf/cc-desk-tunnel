# 本机聊天记录副本（P1，规格 v2.1）

本功能只在桌面客户端保存本机打开过的会话尾部副本。Ubuntu 仍是唯一权威；浏览器连接不调用缓存。同步完成前沿用“同步会话”和原有输入、控制禁用规则。没有实现离线会话列表、启动即浏览或后台预热；服务端与协议未改，协议版本仍为 24。

## 身份与位置

主进程对以下不含密钥的 owner 原文计算 SHA-256：

| 连接方式 | owner 原文 |
| --- | --- |
| 邮箱工作空间 | `email\|<access.login/access.load 返回的 email 小写>\|<nodeId>` |
| 远程手动 | `manual\|<form.url>\|<form.fingerprint>` |
| 本机 | `local\|<form.url>` |

邮箱取账号服务返回值，不取表单；没有可靠 email 或 nodeId 时，本次连接不启用缓存。ticket 的地址、指纹和 token 均不参与 owner。不同工作空间的目录相互隔离，切换后保留各自副本。

每个连接 profile 的 `<userData>/history-cache/<owner哈希>/` 下：

```text
meta.json          {"format":1,"protocol":24}
<sessionId>.jsonl  第一行：{"format":1,"sessionId":"UUID","firstSequence":1,"hasEarlier":false}
                   之后每行一个线上格式的 SessionEvent
```

format/protocol 不匹配只清空当前 owner 目录。owner 原文和密钥不落入文件或日志。副本未加密，与草稿一样依赖当前用户目录权限；POSIX 目录为 0700，文件为 0600。

## 主进程存储规则

`electron/history-cache.cjs` 只使用异步 fs，同一个 owner/session 的读写删除按 Promise 链串行。调用进入时绑定 owner，异步完成后不会操作另一个工作空间。重写先写独立临时文件、sync、关闭，再 rename；Windows 临时拒绝 rename 最多尝试五次。追加只接受严格大于末条 sequence 的事件，不要求 sequence 连号。

UUID 校验阻止会话文件路径穿越；事件须有正整数 sequence、字符串 runId 和匹配的 sessionId；单次事件输入最多 4 MiB。JSONL 末行 JSON 不完整时读取有效前缀，下一次追加先重写修复末行。中间损坏、非法结构、倒序等异常删除整份副本。渲染器另外用 eventSchema 校验首尾各 20 条。

每个窗口最多 2000 条或 1 MiB，超出后从头按完整 run 丢弃，更新 firstSequence/hasEarlier。所有 owner 的 JSONL 总量最多 200 MiB，后台按文件 mtime 从旧到新淘汰，跳过当前选中及观察中的会话。`protect(ids)` 是为此新增的本机 IPC；`retain(ids)` 仍专用于 ready 会话列表对账，不兼作保护列表。换 owner 或断开连接释放旧保护。启动/重写后后台清理 90 天未使用的 owner 目录。

`clear()` 删除整个 history-cache 目录，返回删除的 JSONL 字节数；`usage()` 统计所有 owner 的 JSONL 字节数。开启状态下后续权威写入可重新建立目录与 meta；关闭后不会重新写入。meta 和临时文件不计入用户看到的聊天副本占用。

## 渲染器同步规则

1. connect 先打开 owner 缓存，失败仅在 client.log 留一条诊断，随后继续网络连接。connectBrowser 完全跳过缓存。
2. 先异步注水，再 session.subscribe。相同连接中同一会话合并并发读取；await 后重新检查连接代次、socket、当前选中/观察状态和内存 history，迟到结果一律丢弃。重连换 socket 会重建读取，避免丢弃旧结果后忘记订阅。
3. 注水只写 events/history，保持 loaded=false、loading=true。新建订阅重新等待 snapshot；只有仍在 pending 中且属于当前缓存会话的 replace/append snapshot 才设置 synced。prepend 只重写已经 synced 的窗口。
4. 断线、connect、connectBrowser、disconnect 清空 synced。只有 synced 会话的持久化事件可以写盘；fragment、live 和 progress 永不写入。额外的 provenLast 记录完整内存窗口的可信末尾，避免订阅超时后全局流式事件错误推进重试游标。
5. replace/prepend 重写完整窗口；append 仅在已持久化游标匹配该订阅请求的 afterSequence 时追加，否则重写。流式写盘按会话合并，最多每秒一次。beforeunload 通过 disconnect 立即提交剩余完整窗口到 IPC，不依赖卸载后仍能执行渲染器 Promise；主进程负责串行收尾。
6. invalid_cursor 删除副本并清空该会话内存，静默从 0 重试一次；第二次失败显示正常错误。not_found、session.deleted 删除副本，ready 在当前 owner 内 retain 会话列表。内存淘汰时同时丢弃磁盘游标，读盘为空不能再用旧游标。

桌面读取副本时保存阅读位置；同一会话同步状态变化不会重新启用自动跟随。跟随模式下补拉仍停在底部。浏览器的原有滚动分支不变。

## 设置

“设置 → 常规 → 本机聊天记录”包含默认开启的“在本机保存聊天记录”和“清除本机记录（占用 N MB）”。偏好沿用 prefs，并随已有本机共享偏好同步。关闭立即使异步读取与待提交写入失效，清除该 profile 下所有 owner 副本。手动清除不删除服务器历史。

## 验证与复现

使用 Node 24。核心用例位于 `test-main/history-cache.test.mjs`、`history-owner.test.ts` 和 `local-history-client.test.mjs`；邮箱 owner 的真实 App 接线回归在 `test/email-login.spec.ts`。

真实 Electron 用例 `test/local-history-cache.spec.ts` 使用隔离 profile、真实 preload/IPC/JSONL 和本地合成 WebSocket 服务，覆盖关闭重启、订阅延迟三秒时先显示副本、增量补拉与跟随、同步期间向上阅读后 replace、关闭开关后的原有网络加载路径。隐藏 smoke 窗口的滚动用真实 DOM wheel/scroll 处理器驱动，不依赖不可见窗口接收 OS 鼠标消息。

```powershell
npm run check
npm test
npm run typecheck
npm run format:check
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run test:ui -- apps/desktop/test/local-history-cache.spec.ts apps/desktop/test/email-login.spec.ts apps/desktop/test/conversation-follow.spec.ts
node scripts/benchmark-local-history.mjs
```

`client.log` 的 `history-cache hydrate events=N selectToStateMs=X` 从 select() 入口起计，到 events 写入 state 为止，包含选择切换、IPC、读盘和 schema 抽查，不包含 React 完整绘制时间。最终真实 Electron 的 2000 条实测为 **18.4 ms**（门槛 50 ms）。主进程模块独立基准对 2000 条、约 819,794 字节窗口执行 10 轮重写/读取/追加，async_hooks 测量不含异步 IO 等待的同步回调壁钟时间；最终最长 **1.534 ms**（门槛 8 ms）。这些是本机受控负载的实测值，不是对所有硬件的延迟保证。

最终验证：npm test 共 1021 项，958 通过、63 条条件跳过、0 失败；新增缓存专项 39/39 通过，无跳过。相关 UI 31/31 通过；计时起点校正到 select 入口后，2000 条专项再验 1/1 通过。check、typecheck、format:check 和 diff 检查通过。见 [结构化验收证据](evidence/local-history-cache-2026-11-08.json)。

## 规格说明与边界

- v2.1 第 4.2 节及用户确认优先于第 6 节残留的“owner 变化时清空”旧文案；owner 切换保留不同目录的记录。
- 规格预计不需要改滚动代码，但可控测试实际复现约 1790 px 跳动，故补充桌面端阅读位置处理。
- 已获用户明确允许，单独补齐基线 .dockerignore 漏列的两个部署文件；不涉及服务端逻辑、协议或部署。
- 必需的格式检查发现既有 parallel-workspace-tickets evidence JSON 不符合 Prettier，已单独提交纯格式修正，并验证解析后的 JSON 内容完全不变。全量测试的一次既有 Windows launcher 临时目录清理曾报 EPERM，随后完整重跑通过，未改动该测试或运行代码。
- P1 沿用现有协议的限制：服务端恢复后若相同 sequence 对应内容已变、但游标仍不越界，客户端无法可靠识别。anchor 校验属于 P2，本轮未实现。
- 所有验收使用合成聊天内容与本地服务，未调用模型，未打安装包、发布、推送或合并 main。
