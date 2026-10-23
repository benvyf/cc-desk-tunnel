# 单节点文本审核门禁

> 原生终端恢复评估：用户选择继续强制审核。官方故障阻断选项 `onFailure: "block"` 要求 CLI 2.1.295 及以上，当前固定 2.1.293 不能直接满足；未改生产、未升级 CLI、未发送模型请求，终端保持禁用。详见 [可行性与后续隔离验证条件](NATIVE-TERMINAL-MODERATION-ASSESSMENT.md)。

> 当前状态（2026-10-23）：ubuntu-cc 已回传正式启用 PASS，客户端基础验收三项全部通过；真实消息的 JEV→Claude 完整链路尚未验收。切换脚本 `260224cbf2c7ba41db9e282fab94b2db5bf71d6f`；已验收镜像 `c132c31b978f47bcf5783cf374b841eddd86d6eef343cca751426691406d6e24`。本次切换未发送 Claude 模型请求，CLI/SDK、账号和路由一致。临时 SSH 领取授权已撤销，节点凭据保留；其余五台暂缓。下文准备与切换前状态是历史记录。

本阶段在 ubuntu-cc 调用现有 Claude CLI 之前增加独立 HTTPS 文本审核。官方 CLI、SDK、启动参数、登录凭据、网络与代理、遥测配置保持原样；不发送额外 Claude 试验请求，不进行账号切换、协议转发或指纹修改。此设计不能保证平台不会触发账号风控。

## 覆盖范围

- 普通消息、运行中的追问：审核通过后才记录用户消息、写入 CLI 或创建运行。
- 继续、压缩：连同 CC 记录的全部用户消息审核，不静默截断。超过 64 KiB 时拒绝，管理员可根据节点日志确认限制并指导缩短内容或新建会话。
- 问题回答：审核问题与答案文本；拒绝后保留待回答状态，允许修改重答。
- 通过 CC 修改的非空全局说明：先审核再保存。
- 原生终端无法逐键可靠审核，启用门禁的节点拒绝打开终端；不修改 CLI、不注入提示钩子。

这属于 CC 输入入口的文本门禁，不是全部模型上下文的安全隔离。历史模型输出、工作区文件、外部工具输出、用户直接登录机器后启动 CLI 等未在此层强制审核。JEV 和关键词均存在误判、漏判，不能承诺零绕过。

## 时序与失败处理

相同会话的模型输入跨连接排队，审核等待期间禁止会话修改；停止运行保持可用。审核后复查连接和运行身份。断线、超时、非 200、无效响应、任何未明确允许的结果均停止提交。无自动重试。普通客户端统一显示通用操作失败；详细结论在管理中心，节点侧只记录关联 ID 和稳定错误码。

现有 Windows 客户端普通命令超时为 10 秒。节点单次审核上限 7.5 秒，排队请求从到达起最多等待 8 秒，截止后不迟到启动 Claude。管理员设置的 JEV 超时若更长，节点依然遵循更短截止时间；VPS 可能继续完成该次 JEV 并计费，但不会因此获得节点放行。

## VPS 接口与凭据

精确入口 `POST /cc-updates/v1/moderation/check`，只使用独立节点 Bearer 凭据。管理员密码、管理员令牌、JEV 密钥不下发节点。请求包含 nodeId、requestId、sessionId、deviceId、kind、text，最多 64 KiB 文本。响应只返回审核编号与 allowed。

私有注册表 `private/moderation-nodes.json` 保存节点凭据 SHA-256，逐次读取，删除对应项即可撤销。重复请求在五分钟内复用结果，相同 ID 不同内容拒绝。节点不能访问管理员接口，管理员令牌也不作为节点凭据。

root 在 VPS 使用 `scripts/create-moderation-node.mjs` 创建配置，文件 0600。节点用 `PROXY_MODERATION_CONFIG=/data/config/moderation-node.json` 读取独立配置；该变量随后从 CLI 继承环境移除。配置文件应属于容器 uid 1000、权限 0600。

审计沿用管理中心记录和 JEV 用量累计，类型为 `node.review`，记录节点、请求/会话/设备 ID、结论、分数、耗时、文本 SHA-256 和字节数，数据库不存审核正文。传给 JEV 的正文遵循已有审核服务约定。

`enforcement: node-api-ready` 仅表示 VPS 接口就绪，不能据此宣称所有节点已启用。是否完成试点需以该节点部署结果和节点审核记录为准。

## Ubuntu 隔离准备

`scripts/prepare-moderation-pilot.py --source <固定40位提交>` 仅适用于 ubuntu-cc 的已验收基础镜像 e3275f6f27d5。它只覆盖 server.ts、config.ts、moderation.ts，不安装依赖；构建禁用网络、不拉取基础镜像。校验 CLI、SDK、CLI 包装与账号/终端实现、入口脚本字节相同，镜像环境/入口/用户/健康检查不变。

隔离测试容器使用 `--network none`，无生产数据或凭据挂载，以模拟 adapter 和模拟审核验证允许/拒绝、超时、继续历史与终端限制。不执行 Claude。生产容器 ID、镜像和启动时间必须保持不变。

准备完成只输出脱敏结果和一次性领取配置用的 SSH **公钥**。私钥留在节点。后续可在 VPS 为该公钥配置短时有效、强制只读此节点配置、禁止端口转发和其他命令的 SSH 授权，再通过 SSH 领取配置，无需在聊天传递任何密钥。启用前重新确认节点空闲并断开客户端；保留当前镜像及一致性备份以支持回退。其他五台节点不在本阶段范围。

用户已将两个新增类别阈值改为 0.5，部署必须完整保留当前数据库中的阈值、关键词、JEV 密钥和管理密码，不使用代码默认值覆盖。

## 2026-10-23 部署进度

VPS 管理服务已部署源码 `2638731374c87e767eca6ff1ec37b6a7352ab4d1`，24 个运行文件清单通过校验。新接口的公网认证、关键词拒绝、重复请求去重、管理员/节点权限隔离和临时节点凭据撤销已验证；未调用 JEV 或 Claude。数据库策略及密钥、管理密码、签名发布状态与部署前相同，两个新增类别均保持 0.5，自动续期 timer 已恢复。

首次公网探测遇到 Nginx reload 后旧 worker 尚未退出而自动回退；加入仅针对未认证入口的短暂等待后再次部署通过。此前失败没有修改 Ubuntu。

私有部署证据 `/root/.cc-update-admin/maintenance/moderation-gate-2638731374c8-r2/result.json`；此前运行目录 `/opt/cc-update-service.previous-moderation-gate-2638731374c8-r2`。凭据仍只保存在 VPS；尚未正式签发 ubuntu-cc 节点凭据。

本地已通过核心门禁测试、相关原有消息路径、管理 API/用量测试、类型检查及真实浏览器管理页面测试。隔离检查脚本在本机以同样模拟逻辑通过；**Ubuntu 镜像构建和节点启用尚待执行，当前生产 CC 消息仍未接入审核**，不能据 VPS 上线宣称完成试点。

下一步在 ubuntu-cc 执行以下固定源码的准备命令，不需要停止正式服务：

```bash
curl -fL 'https://raw.githubusercontent.com/benvyf/cc-desk-tunnel/2638731374c87e767eca6ff1ec37b6a7352ab4d1/scripts/prepare-moderation-pilot.py' -o /tmp/cc-moderation-2638731.py && echo 'ab1c224707d66c0af2ac4cffa18aa5db43c7177dd67050d1b862c73e22b9eef8  /tmp/cc-moderation-2638731.py' | sha256sum -c - && sudo python3 /tmp/cc-moderation-2638731.py --source 2638731374c87e767eca6ff1ec37b6a7352ab4d1
```

回传末尾 JSON、PASS 和 `ENROLLMENT_PUBLIC_KEY` 公钥行。私有状态在 `/var/lib/cc-moderation-pilot-2638731374c8`。不要回传里面的生产 inspect 或私钥。收到结果后再签发节点凭据，通过受限临时 SSH 领取；正式切换前重新确认空闲、断开旧客户端并准备一致性备份与回退，不能沿用早先的空闲确认。

## Ubuntu 隔离准备已通过，等待空闲切换

用户回传的 ubuntu-cc 准备结果全部通过，测试镜像 ID 为 `sha256:c132c31b978f47bcf5783cf374b841eddd86d6eef343cca751426691406d6e24`；受保护文件一致、正式容器未变、模型请求为 0。不能再重复构建或重新检查已验收旧代码。

独立节点凭据现保存在 VPS `/root/.cc-update-admin/nodes/ubuntu-cc.json`，服务私有注册表只保存其哈希，已验证认证成功。用户回传的 SSH 公钥已获准临时读取**此文件**，带 `restrict`、强制命令和 UTC `2026-10-23T15:09:50Z` 到期时间（香港时间当日 23:09:50）。禁止 PTY、转发、agent 和任意其他命令；无 JEV 密钥或管理员令牌下发。若领取前授权已经过期，只续期这一条受限授权，不能更改管理密码、节点凭据或放开 SSH 权限。

`scripts/activate-moderation-pilot.py --idle-confirmed` 的切换顺序：

1. 核对已准备的固定镜像、正式容器与数据挂载；通过固定 VPS SSH 主机公钥领取此节点配置到节点 root 私有目录。
2. 从与正式容器相同的网络命名空间发送一个空审核对象，预期认证后返回 400，确认凭据和连通性；空对象不会到达 JEV。
3. 检查会话库没有 activeRun，停止此空闲节点并在本机保存一致性 `data.tar`、原 `service.env` 和 compose 环境文件。旧镜像单独打保留标签，无需再次导出整个镜像到另一台机器。
4. 仅新增 `PROXY_MODERATION_CONFIG=/data/config/moderation-node.json`，配置属 uid 1000、权限 0600；切换到已经隔离验收的镜像，不构建、不拉取、不升级 CLI。
5. 验证健康、TLS、控制认证，以及已有会话的 terminal.open 被拒绝；不发送 message.send、continue、compact 或账号命令。核对容器环境、路由与挂载、受保护账号/配置文件不变。

脚本在 VPS Linux 临时目录使用模拟 Docker/SSH/健康检查的 4 个核心测试通过，覆盖配置保留/备份、启动验证失败后的自动回退、认证前检失败不停服，以及稍后回退保留新用户文件；测试未调用模型或真实 Docker。

启用失败时自动恢复原镜像及两个环境文件，保留数据；因会话库代码与 schema 未改，不自动用旧数据覆盖用户历史。一致性数据档仅供必要时单独恢复。脚本保存为节点状态目录的 `activate.py`；手动回退命令为 `sudo python3 /var/lib/cc-moderation-pilot-2638731374c8/activate.py --rollback`。备份校验不通过会停止。

用户已确认当前节点空闲、客户端断开，并执行 `bb4b358` 版切换脚本；脚本在第一步凭据领取/端点前检中止，尚未停服、备份或切换。VPS 记录确认领取公钥认证成功。发现端点前检的 `docker run` 缺少 `-i`，导致传入的 Node 检查脚本不能从 stdin 进入容器；已补上该参数，并新增直接覆盖真实 `receive_config` 参数的回归测试（修复前失败、修复后通过）。Linux 上全部 5 项脚本核心测试通过，无模型请求。

修复后沿用本次空闲确认、已验收镜像和已领取配置重试，没有重新构建或轮换凭据。

## 正式切换及客户端基础验收通过

原生终端的后续候选方案见 [官方 2.1.295 终端审核评估](NATIVE-TERMINAL-MODERATION-ASSESSMENT.md)。候选准备不改变本节生产状态；恢复终端仍有未完成的输入路径验证，不能直接启用。

用户执行 `260224c` 版脚本回传 PASS：`moderationEnabled=true`、`terminalDisabledVerified=true`、`cutoverPerformed=true`、`rolledBack=false`、`modelRequests=0`；协议 20、TLS、控制认证通过，CLI/SDK、凭据和路由保持不变。节点一致性备份在 `/var/lib/cc-moderation-pilot-2638731374c8/activation-backup`，正式结果在同级 `activation-result.json`。

已在 VPS 撤销仅对应此次领取公钥的一条 SSH 授权，保留其他管理员 SSH 授权、节点凭据和注册表。VPS 记录 `/root/.cc-update-admin/nodes/ubuntu-cc-activation-reported.json` 明确区分用户回传的节点证据与本机实际完成的授权撤销；当前电脑仍无 Ubuntu SSH 管理通道。

用户已回传客户端三项全部通过：原会话历史、设备归属和统计正常；普通工作区文件可查看；原生终端按预期被拒绝。此验收未发送聊天消息、继续或压缩，不自动调用 Claude。普通客户端拒绝可能只显示“操作失败，请稍后再试”，详细原因在管理端或节点日志。下一步可由用户在正常使用时发送一条普通无害消息，核对回复和管理中心的 ubuntu-cc 审核记录、JEV 用量；在此之前，真实用户消息的完整 JEV→Claude 链路仍标记未验收。
