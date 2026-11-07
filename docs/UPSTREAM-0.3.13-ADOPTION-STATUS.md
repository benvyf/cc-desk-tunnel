# 上游 0.3.13 吸收实施记录

2026-11-07，香港时间。分支 `codex/upstream-013-adoption`，源码基线 `2550318`。范围见[实施方案](UPSTREAM-0.3.13-ADOPTION-PLAN.md)。尚未发布、部署或替换用户安装包。

## 第一批

- Windows scp/sftp 路径增加盘符前导斜杠，原项目路径不改；旧聊天提示通过说明版本补充，新终端生成修正描述。
- 终端状态栏上下文与额度分别去重，空额度不阻止上下文刷新；重复测量时间不新增事件，上下文单独变化按会话订阅发送。
- 当前 PTY 从选定配置目录、项目、local 和显式 settings 解析压缩窗口快照，保留原用户状态栏与配置隔离。
- 核心回归 19 项通过，覆盖路径、旧说明、设置优先级、上下文独立更新和重复采样；类型检查通过。

### 真实 CLI 隔离实验

在可访问的 Linux 主机 `/tmp/cc-space-adoption-20261107-01a1b3d1` 独立目录运行官方 Linux CLI 2.1.295，下载按 npm 发布 SHA-512 校验。主机服务未停止或修改；实验使用独立 HOME/CLAUDE_CONFIG_DIR、虚构测试 API key 和仅监听 127.0.0.1 的受控 HTTP 响应器，没有使用生产 Claude 账号或请求真实模型服务。

实际 `/context` 分别确认显式 settings 160K、移除后 local 140K、project 120K、user 100K 的优先级。交互 CLI 状态栏报告模型窗口 200K，输入 50,110 tokens，证明状态栏窗口不会自动使用较小自定义窗口；同一交互进程运行中修改显式 settings 至 180K 后 `/context` 仍显示 160K，支持使用启动快照。

真实 JSONL 的 assistant 父节点经过 attachment/system 条目，并非直接指向上一条 user；后续读取保留真实 SDK 主链解析，避免手写“只接 user/assistant”链过滤。

本机实验原始日志 `.local/adoption-cli-gate.log`、录制 `.local/adoption-real-cli.jsonl`、关键回归 `.local/adoption-batch1-core.log`。日志均为合成提示词和受控回复；不能把这项 CLI 实验称为真实 provider 验收。Windows 真实 SFTP 往返及完整发行包验收仍待后续批次联调。

## 后续

第二批：受控增量历史、持久转译状态、原子事件导入和本地命令展示。

第三批：设备 Shell 能力、Git Bash/偏好/界面、兼容 SSH 包装器与混合版本验证。
