# 单节点文本审核门禁

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
