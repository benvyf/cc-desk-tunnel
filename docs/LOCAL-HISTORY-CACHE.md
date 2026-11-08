# 本机聊天记录副本（P1）

本功能按规格 34 v2.1 及 `34-review-4fe343a.md` 的修订实现。Ubuntu 是唯一权威；桌面保存可丢弃的本机副本，先显示已打开过的会话，再补拉新增事件。浏览器不调用缓存；P2 离线会话列表、anchor 协议和 P3 后台预热均未实现。服务端和线上协议未改。

## 身份与文件

主进程对不含密钥的 owner 原文计算 SHA-256：

| 模式 | owner 原文 |
| --- | --- |
| 邮箱工作空间 | `email\|<access.login/access.load 返回的 email 小写>\|<nodeId>` |
| 远程手动 | `manual\|<form.url>\|<form.fingerprint>` |
| 本机 | `local\|<form.url>` |

邮箱身份不取表单或 ticket。没有可靠 email/nodeId 时，本次连接不启用缓存。各 owner 位于 `<userData>/history-cache/<owner哈希>/`，切换工作空间保留各自记录。

```text
meta.json          {"format":1,"protocol":<PROTOCOL_VERSION>}
<sessionId>.jsonl  第一行：{"format":1,"sessionId":"UUID","firstSequence":1,"hasEarlier":false}
                   之后每行一个线上格式的 SessionEvent
```

渲染进程调用 `open(owner, PROTOCOL_VERSION)`；主进程校验正安全整数，format/protocol 不匹配只清空当前 owner 目录。版本不在存储模块写死。文件头没有 discardedRun 字段。

打开 owner 时，元数据的 IO 读取与 JSON 校验分开处理：EBUSY/EPERM 等读取错误使本次缓存打开失败并保留原目录，不能当作版本不匹配清空。切换协议前等待此前已提交的操作结束，包含尚未进入会话写链的操作，避免旧版本写入在清空后重新出现。

副本未加密，依赖当前用户目录权限；POSIX 目录 0700、文件 0600。会话文件名必须是 UUID；事件须有匹配的 sessionId、正整数 sequence 和字符串 runId。

## 窗口与主进程

1 MiB / 2000 条是尾部窗口的软预算：从完整 run 边界截取，始终保留最新一轮，即使它单独超过软预算。只有最新一轮单独超过 4 MiB 时才跳过该会话的副本，不关闭其他会话或本次连接的缓存；新的一轮回到预算内后可重新记录。1.5 MB 单轮可以保存和注水。

渲染器在 `historyWindow.ts` 截取后才发 IPC；prepend/replace 不发送完整的约 6 MB 内存历史。主进程 replace 也独立裁剪超量输入而不因总量超过 4 MiB 抛错。裁剪后更新 firstSequence/hasEarlier，不改变界面已加载的完整内存历史。

同一 owner/session 的异步读写、删除按 Promise 链串行，并在调用时绑定 owner。重写采用独立临时文件、sync、关闭和 rename；Windows 临时拒绝 rename 最多尝试五次。主进程在内存索引中记住末条 sequence、字节数、事件数及最新 run 的预算；常规追加直接 appendFile，不再整份读取。首次冷追加可以懒读一次；需要裁剪或修复末行时转为重写。

JSONL 末行半截忽略有效前缀以外的部分；完整末行缺换行时，下次追加先重写分隔符。只在解析、校验或大小校验失败时删除文件；EBUSY、EPERM 等 IO 错误返回 null 并保留文件。渲染器另外抽查首尾各 20 条 eventSchema。

所有 owner 的 JSONL 总量目标为 200 MiB，维护时按文件 mtime 从旧到新淘汰，保护当前选中/观察会话。维护只由重写触发，扫描开始至少间隔一分钟；追加和单纯打开不触发全目录扫描。同一维护任务还清理 90 天未使用的 owner 和可识别的崩溃临时文件，并保护正在写入的临时文件。因此容量与过期回收按维护节奏生效。

`retain(ids)` 用于 ready 列表对账；`protect(ids)` 用于淘汰保护。`clear()` 清空该 profile 下所有 owner 副本，返回删除的 JSONL 字节数；`usage()` 统计全部 owner 的 JSONL 字节数，meta 和临时文件不计入聊天占用。

## 注水、同步与控件

- 先异步读盘，再订阅；同一连接同会话合并并发读取。await 后核对当前选中/观察角色、socket/代次、权威 history，过期结果不注入。重连换 socket 会重新读取并补发订阅。
- 注水沿用 history.loading 显示“同步会话”。同步失败（含超时、session_busy）清除未确认/pending 标记，设 loading=false，显示错误，并恢复原有控件行为；原有连接、忙碌、权限等禁用条件仍有效。重新点击当前会话行会重试，成功后恢复内容。
- 停止只依赖服务端 activeRun 及原有可操作条件，不受历史同步状态限制。主聊和侧聊的停止按钮、双 Escape、stop/control 都不检查 historyPending。同步期间打开终端按钮显示为禁用；失败结束后解除历史同步造成的禁用。
- 只有当前连接接受有效 replace/append snapshot 后才允许持久化该会话。断线、connect、connectBrowser、disconnect 清空 synced；fragment、live、progress 永不写盘。prepend 不能证明未补齐的尾部。provenLast 保留可信补拉游标，避免超时后的全局帧跳过中间事件。
- replace/prepend 写入裁剪后的尾部窗口。append 不仅要求已处理游标匹配请求 afterSequence，还比较完整内存历史与裁剪窗口中 `sequence > persistedLast` 的事件数量；只有数量相等才追加，否则重写完整尾部窗口，避免被排除的上一轮留下永久缺口。该检查位于共用 persistHistory，覆盖 snapshot append 与流式 flush；排队写入执行时使用当时的 persistedLast。流式事件按会话合并，最多每秒一次。beforeunload 立即提交剩余窗口到 IPC，主进程串行处理。
- invalid_cursor 删除副本、清空该会话内存，按当前主聊/观察角色静默从 0 重试一次；not_found/session.deleted 清理副本，ready 在当前 owner retain。磁盘故障、清除失败或开关交错仍会接续当前可见会话的网络订阅；清除期间收到的 snapshot 也能建立连续性证明。
- 正常淘汰导致追加文件不存在时，从已确认的尾部窗口原子重建；异步拒绝后的回退再次检查 socket/代次，不能跨 owner 写旧窗口。桌面保留同步期间的阅读位置，跟随时补拉停在底部；浏览器原有滚动和连接分支保持。

## 设置与诊断

“设置 → 常规”包含默认开启的“在本机保存聊天记录”和带 `button` 样式的“清除本机记录（占用 N MB）”。偏好沿用 prefs；关闭使待提交缓存操作失效，并清空全部 owner 副本。手动清除不删除服务器记录。

缓存诊断经 main.cjs 已有的 log() 写入 client.log，复用 client-log.cjs 的轮转，不再维护第二个写入/轮转实现。日志只含错误阶段、数量和耗时，不含 owner 原文、密钥或聊天内容。

## 验证

最新 b2768de 尾部追加缺口修复结果：全量 **992 通过 / 0 失败 / 63 条件跳过**；专项 **73/73 通过**。完整 UI 最终 **84/84 通过、退出码 0**。2000 条 select 到 state 实测 **15.7 ms**，主进程最长同步回调 **1.392 ms**；类型、格式、索引及 diff 检查通过。

新增的 snapshot append 与流式 flush 两个回归使用真实主进程 JSONL：先持久化 X 的 1..100（约 900 KB），再接收 X 的 101..115 与 Y 的 116..118；两条路径都必须调用 replace 而非 append，最终文件只有完整 Y 轮 116..118、firstSequence=116、hasEarlier=true，内存保留全部 118 条。两用例在旧实现均失败，修复后通过。可选的 prepend 首尾不变去重不属于本次正确性修复，未实现。

本轮 UI 前两次完整运行各有一个既有鼠标输入用例失败（拖选目标偏到标题、滚动未触发更早历史请求）。两用例均未修改，各原样重复两次通过，最后完整重跑 84 项全部通过；统一证据保留了失败与重跑说明。

本轮补齐元数据临时 IO 错误与协议切换期间在途写入的回归。测试夹具还明确将初始阅读锚点居中（原位置稳定性断言保留），并在最终清理时只终止 Playwright 专用的 Electron 进程树；真实关闭/重启验证仍沿用原有关闭流程。产品端未改变最新审查确定的失败恢复、停止、窗口和限频策略。

使用 Node 24；所有内容为合成聊天、本地 WebSocket 与隔离 Electron profile，没有调用模型、部署或发布。统一证据为 [local-history-cache-2026-11-08.json](evidence/local-history-cache-2026-11-08.json)：current 保存本次结果，history 保留既往验收快照。

```powershell
npm run check
npm test
npm run typecheck
npm run format:check
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run test:ui -- apps/desktop/test/local-history-cache.spec.ts apps/desktop/test/side-history-stop.spec.ts apps/desktop/test/email-login.spec.ts apps/desktop/test/conversation-follow.spec.ts apps/desktop/test/quoted-conversations.spec.ts apps/desktop/test/terminal-status.spec.ts
node scripts/benchmark-local-history.mjs
```

审查编号与回归对应：

| 编号 | 实现与验证 |
| --- | --- |
| 1 | subscribe 失败后 pending=false、loading=false、错误可见、输入可用；单元及真实 Electron 验证重选当前会话恢复。 |
| 2 | 移除主/侧聊 stopRun、快捷键和 stop/control 的历史门槛；主聊真实 Electron 与 SideConversation 组件分别测试按钮和双 Escape。 |
| 3 | 约 6 MB replace/prepend 内存窗口只发完整尾部 run；主进程超量 replace 裁剪；缓存保持可用。 |
| 4 | 最新 1.5 MB run 完整保存/注水；只有最新单轮大于 4 MiB 才跳过该会话，其他会话正常；已删除 discardedRun 实现和相关测试。 |
| 5 | spy 验证常规 append 零整文件读取、零目录扫描；冷追加只懒读一次；可控时钟验证重写维护一分钟限频。 |
| 6 | open 传实际协议；非法值拒绝；协议变化只清理对应 owner，并等待先前操作结束，防止旧格式写回。 |
| 7 | 日志复用已有 log()；去掉重复轮转。 |
| 8 | 历史及元数据分别注入 EBUSY/EPERM，文件/owner 数据均保留；历史读取返回 null，元数据打开拒绝后走网络回退。 |
| 9 | 清除按钮使用 className="button"。 |
| 10 | 真实 Electron 持有缓存同步时终端按钮禁用、snapshot 后启用；未选过会话的首次菜单点击也能发送模拟 terminal.open，不会被点击本身引发的读盘吞掉。 |

### 合并的历史复审记录

下表保留原 REVIEW / FAULT-REVIEW 的发现及现行处理；其中强制失败后只读、丢弃最新超长 run、discardedRun 与每次追加扫描的旧策略已按本次审查撤回。

| 历史发现 | 现行处理 |
| --- | --- |
| prepend 错误提升缺口后的尾部游标 | 只在尾部已证明完整时推进；超时后的重试仍从可信游标补齐。 |
| 迟到 invalid_cursor 抢占其他主会话订阅 | 检查当前选中/观察角色，以正确 retain 重试。 |
| 失败后的 pending/unconfirmed 让控件长期锁定 | 按本次编号 1 恢复失败行为；停止按编号 2 独立可用。 |
| 重新开启未恢复当前对话记录 | 开启成功后重新同步主聊和观察中的侧聊。 |
| 读盘期间关闭丢掉网络加载 | 当前可见会话恢复不使用缓存的订阅。 |
| 完整末行无换行造成追加粘连 | 下次追加原子修复；半截末行读取有效前缀。 |
| 写入/清除故障吞掉网络加载 | finally/失败回退按当前可见会话恢复并去重；旧连接完成不影响新连接。 |
| 清除与关闭交错丢掉订阅 | 共用可见会话恢复入口，不依赖被清空的旧读取集合。 |
| 清除期间的 snapshot 丢掉 synced | 连续性证明与临时存储可用性分开。 |
| 正常淘汰后追加失败停用缓存 | 用已确认窗口重建，拒绝后再检查 owner/socket 代次。 |
| 追加增长触发频繁全目录维护 | 按本次编号 5 改为重写后、一分钟限频。 |
| 整组丢空后同 run 以半截复活 | 按本次编号 4 始终保留最新整轮至 4 MiB；删除 discardedRun。 |
| 崩溃临时文件漏回收、可能误删活动写入 | 在重写维护中回收本模块命名的遗留文件，活动临时文件受保护。 |
| 元数据临时读取失败误清空 owner | IO 与 JSON 校验分开；读取失败保留数据并拒绝缓存打开。 |
| 协议清理期间旧写入恢复旧格式数据 | 打开/协议切换等待此前操作结束，再进行校验与清理；交错操作能正常收尾。 |
| 裁剪后的尾部窗口漏掉游标之后的上一轮增量 | 追加前比较完整内存和窗口中的新增数量，不相等就重写；snapshot/flush 两个真实 JSONL 回归验证最终只保留完整 Y 轮 116..118、hasEarlier=true，不出现 1..100 + 116..118。 |

历史验收快照：首轮单元 959 通过/63 跳过、专项 40、UI 31；细节复审单元 965/63、专项 46、UI 78；故障复审单元 975/63、专项 56、UI 78；`4fe343a` 审查修复后单元 987/63、专项 68、UI 组合 83 加终端补测 2（重复一项）。它们是各阶段的记录，不覆盖本次变更后的验收，完整数据已合并到统一证据的 history。

保留三个合理的基线修复：.dockerignore 两条精确白名单、parallel-workspace-tickets evidence JSON 的纯格式化、quoted-conversations SSH 测试桩；本次没有修改它们。原计划文件和两份独立复审文档删除，benchmark 脚本保留。

P1 仍沿用当前协议的边界：备份恢复后若同一 sequence 的内容变了、游标却不越界，需要 P2 anchor 才能识别。本轮没有引入新协议或预热行为。
