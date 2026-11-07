# 上游 0.3.13 吸收实施记录

2026-11-07，香港时间。三批源码实施完成，分支 `codex/upstream-013-adoption`，基线 `2550318`，功能提交 `5ac54c1`、`e36a491`、`5f6d157`，UNC 提示边界补齐于 `45e72f7`。范围见[实施方案](UPSTREAM-0.3.13-ADOPTION-PLAN.md)。用户明确允许不使用真实模型调用验收，本轮仅用受控接口。未打包发行、部署或替换用户安装包。

## 第一批

- Windows scp/sftp 路径增加盘符前导斜杠，原项目路径不改；旧聊天提示通过说明版本补充，新终端生成修正描述。
- UNC/扩展路径不伪造盘符映射，明确传输写法尚未验证，继续使用设备 Shell 文件操作；普通盘符与 POSIX 路径不变。该提示与 SSH 配置相关检查 26 项通过。
- 终端状态栏上下文与额度分别去重，空额度不阻止上下文刷新；重复测量时间不新增事件，上下文单独变化按会话订阅发送。
- 当前 PTY 从选定配置目录、项目、local 和显式 settings 解析压缩窗口快照，保留原用户状态栏与配置隔离。
- 核心回归 19 项通过，覆盖路径、旧说明、设置优先级、上下文独立更新和重复采样；类型检查通过。

### 真实 CLI 隔离实验

在可访问的 Linux 主机 `/tmp/cc-space-adoption-20261107-01a1b3d1` 独立目录运行官方 Linux CLI 2.1.295，下载按 npm 发布 SHA-512 校验。主机服务未停止或修改；实验使用独立 HOME/CLAUDE_CONFIG_DIR、虚构测试 API key 和仅监听 127.0.0.1 的受控 HTTP 响应器，没有使用生产 Claude 账号或请求真实模型服务。

实际 `/context` 分别确认显式 settings 160K、移除后 local 140K、project 120K、user 100K 的优先级。交互 CLI 状态栏报告模型窗口 200K，输入 50,110 tokens，证明状态栏窗口不会自动使用较小自定义窗口；同一交互进程运行中修改显式 settings 至 180K 后 `/context` 仍显示 160K，支持使用启动快照。

真实 JSONL 的 assistant 父节点经过 attachment/system 条目，并非直接指向上一条 user；后续读取保留真实 SDK 主链解析，避免手写“只接 user/assistant”链过滤。

本机实验原始日志 `.local/adoption-cli-gate.log`、录制 `.local/adoption-real-cli.jsonl`、关键回归 `.local/adoption-batch1-core.log`。日志均为合成提示词和受控回复；不能把这项 CLI 实验称为真实 provider 验收。Windows 真实 SFTP 往返及完整发行包验收仍待后续批次联调。

## 第二批及联调修订

受控历史读取器分块读取追加字节、保留 UTF-8 半行，并缓存原始条目交给真实 SDK 选择主链；Stop 重新核对完整前缀，退出严格校验末行。没有手写替代 SDK 的父链选择。重复采样未变化文件不重建 SDK 快照。

每实例转译器保持回答 ID、工具状态与待判定本地命令；SDK 丢弃的 system/local_command 正文只在主链选择之后按同 UUID 恢复。导入单条源记录的事件先在 SQLite 一次提交，再广播，失败停用该实例同步并保留原历史及诊断；终端输入输出继续可用。关闭的清理与通知置于 finally，避免同步错误遗留实例占用。

针对性核心测试 27 项通过；扩展检查 50 项中 49 通过，唯一失败为基线已有的发行历史漏登记 Windows 31 / Linux 18。已依据仓库对应发行记录追加登记，不修改任何旧 Build、协议或制品；协议检查随后 7/7 通过。真实 CLI 录制经删去 attachment 正文后形成约 10KB 夹具，逐行重放通过，覆盖 system 本地命令与混合父链。

该批桌面构建通过。会话界面 Playwright 5/5 通过，包含迟到回答、命令纯文本、既有终端对话、审批和错误恢复；已查看 `.local/adoption-terminal-notes.png`，沿用现有回答区与说明样式。类型检查通过；完整跨设备与后续修订的结果见下，不将该批结果写成发行验收。

最后的真实 CLI `/compact` 实验补齐两项处理：SDK 在快速压缩后会丢弃旧链中的原始 `/compact`，读取器只为选中的手动压缩边界恢复紧邻的真实人工提问，保持原 UUID 去重，不重放其他旧记录；转译器仍过滤摘要后的重复命令和 Compacted 输出。手动压缩轮次在边界结束，不依赖另一条 Stop。原始录制删去 attachment 正文后保存在测试夹具，先复现缺提问再修复；相关 22 项回归通过，新增压缩界面用例单独通过并查看截图。

终端 `native.compact` 与事件在同一 SQLite 事务内更新冻结提示的 compacted 标记，下一次 SDK 运行使用当前项目和 Shell 描述；后续事件写入失败时标记与事件一起回滚。相关项目/提示/终端/展示 17 项通过。

## 第三批

- 主进程检测 Git for Windows（含 Scoop），通过凭据声明实际 Shell；执行通道探测后才公布，Git Bash 探测失败不拖垮 PowerShell。Linux SSH 目标只声明自己的 Bash。
- 新增“设置 → Shell”，按服务端数据库中的设备 ID 保存偏好，拒绝指定其他设备或不可用 Shell；暂时丢失 Git Bash 时保留偏好。聊天下一条消息生效；既有终端下次新开/重开生效。
- 新服务端 `ready.deviceShells` 在凭据发送前完成协商，旧服务端收到完整旧格式；本机和 SSH 后台桥都覆盖。渲染器不能注入 platform/viaSsh/shells 等执行能力。
- 新别名与 `device-script/device/windows` 共存，Windows 旧脚本入口仍是 PowerShell；不可用保留别名明确失败，不落入 DNS 或用户其他 SSH 主机。
- Ubuntu 每会话生成 ssh/scp/sftp 包装器，保留旧 `.conf` 路径，只修改该 CLI/SDK 子进程 PATH。非设备主机仍读用户 SSH 配置；在实际会话文件系统执行 `ssh -G` 检查可执行性，防止 noexec 挂载使 Shell 跳过包装器。
- 协议保留 24，新增字段和命令受能力声明约束；没有新增 terminalTurnId、CCDT、空闲提醒、缓存 TTL 或空闲自动压缩。

窗口解析还按真实 CLI 校准无效设置：显式 50K 被忽略时，仍使用有效的 user 100K，而不是让无效高优先级值覆盖它；没有有效设置才用模型窗口。启动期配置读取问题只记录路径/错误码，不打印配置内容，也不让辅助统计中断终端启动。

## 主要验收证据

各组有重叠，不将数量相加宣称独立覆盖率。

| 检查 | 实际结果与范围 |
| --- | --- |
| Windows 相关核心 | 154 项通过；后续手动压缩、设置层与提示事务修订分别运行对应回归通过 |
| Shell 协商、别名、偏好、Git Bash 检测 | 40 项通过；另有真实 WebSocket 的设备授权/不可用目标检查 1 项通过 |
| 受管更新 | 56 项通过，覆盖签名、防回放、同版本更高 Build、跨协议限制及独立控制器接入 |
| Linux 跨平台通道 | Ubuntu 24.04 隔离容器中 116 项通过，0 跳过：真实 OpenSSH/SFTP、POSIX 执行、取消及队列、目标适配器和服务端 |
| 最终 Linux 修订 | 在只读、无网络容器中对当前设置/历史/转译/提示事务运行 27 项，通过，0 跳过 |
| Windows 真实执行 | 原生隧道、两种 Shell 和 scp 往返 3 项通过；额外验证 Git Bash 调用 cmd.exe 的中文输出及退出码，通过 |
| 界面 | Shell/原设置 8 项、既有 SSH 设置 3 项、会话原场景 5 项及追加手动压缩 1 项分别通过；已查看正常和窄窗口截图 |
| 构建与结构 | 类型检查、桌面生产构建、索引/文档/模型依赖边界检查通过；按发行配置构建并导入 SSR bridge，确认 Git Bash、SSH 目标及受管服务端客户端在产物中 |
| 当前公开索引 | 用仓库可信公钥验签：Windows 31 / 协议 24 / revision 46，Linux 18 / 协议 24 / revision 30；只读核验，未改变发布 |

### 官方 CLI/SDK 跨设备接续

运行标识 `4a1891e9-b463-40f9-bba1-3213ded3f472`：官方 Linux CLI 2.1.295 和 SDK 0.3.286 实际运行于隔离 Ubuntu，API 指向仅监听 localhost 的受控 HTTP/SSE 服务。

1. Ubuntu SDK → 既有 WSS/SSH → Windows PowerShell，读到 Windows 哨兵并写入临时文件。
2. 同一会话接到原生终端，滚动模式，再次执行成功并同步回答。
3. Ubuntu SDK → 同一 Windows 桌面代理的 SSH 适配器 → Linux 目标，读到 Linux 哨兵并写入临时文件。
4. 同一 Linux 会话接到原生终端，整屏模式，再次执行成功并同步回答。

每侧输出文件恰有 2 次写入；本轮接口请求 8 次、工具调用 4 次、错误 0。终端前端用 xterm headless 响应终端查询并在解析后确认输出；SDK 审批只允许测试的固定 SSH 命令，终端审批也在已知隔离任务中处理。本机没有启动 Claude 或模型 SDK 查询，目标执行链没有启动 Claude 或复制模型账号。

Linux 目标采用同一隔离 Ubuntu 容器中的独立 SSH 执行进程、独立 HOME 和项目目录，实际运行 Bash/SFTP；这不是两个独立物理 Ubuntu 节点的部署验收。模型请求进程仍在 Ubuntu，Windows 仅承担桥接/执行。真实 provider 的行为不属于本轮验收。

原始证据位于本机 `.local/adoption-actual-cli-result.json`、`.local/adoption-actual-cli-run.log`、`.local/adoption-actual-service.log`、`.local/adoption-linux-tests.log`、`.local/adoption-final-linux-run.log` 与各组对应 TAP/Playwright 日志。跨设备共享摘要见 [结构化证据](evidence/upstream-013-adoption-2026-11-07.json)。

实验清理已确认本轮容器与宿主机实验 CLI 进程为 0，仅删除本轮目录中的 CLI 下载、node_modules 和 npm 缓存；原始日志、录制、测试状态及源码保留。未清理其他容器、镜像、账号或生产会话。

## 发行边界

本次完成源码与验收，不代表已安装的客户端或 Ubuntu 得到更新。未分配新 Build，当前清单与公开索引仍为 Windows 31 / Linux 18；未改安装身份、公钥、更新账本、管理中心或旧发行制品。

后续出包/发行须按[强制规则](UPDATE-RELEASE-RULES.md)使用新 Build、干净源码、独立制品、真实安装包/签名索引与续期验收。当前 `deploy/host-update/apply.py` 明确绑定 Build 18，不能只改 Build 号就拿旧迁移入口发布；需新增版本化入口及对当前节点基线的准入，保留空间准备、受控断开、备份/恢复。本文没有把它们计为已发行结果。
