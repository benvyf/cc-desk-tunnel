> 2026-10-24：下文 SSH 公钥交付/启用步骤已被 [一条命令接入计划](2026-10-24-monitor-enrollment.md) 替代；不要执行旧公钥准备脚本。

# 第一台 Ubuntu 被动监控接入

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. 用户已经授权接入和上线；在当前 `codex/account-monitor-production` 分支继续，不另建工作树。

**Goal:** 给 ubuntu-cc 当前 0.3.6／协议20定制运行版本增加已有事件的被动上报，保留审核和原生运行配置。

**Architecture:** 以用户回传并逐文件 SHA256 验证的37文件运行源码为生产基线。对监控前共同源码与当前分支做三方合并，保留审核模块原字节；仅在现有 native.metrics 事件增加请求时间，不增加 CLI/SDK 调用。用当前运行镜像作为离线派生镜像基础，只覆盖必要源码；配置通过限时、强制命令、禁止转发的 SSH 公钥领取包交付，不在聊天传递密钥。

**Tech Stack:** Node24、TypeScript、Node test runner、Python3、Docker、OpenSSH。

- [x] 还原37文件并核对完整manifest；基线镜像 `sha256:75e9c5895bfa232d78905bf1dbf127af173d9f5de88086dc93af80833c8a3b8f`，运行根 `/app`；宿主旧源码不作为部署来源。
- [x] 在 `apps/server/test/monitor-moderation.test.ts` 增加审核与监控同时配置、审核拒绝不启动运行/不制造监控采集、正常模拟输入不伪造账号的集成验证；3项先因缺少审核失败，再合并后通过。已有observer测试覆盖自然事件上报和退出停止。
- [x] 三方合并 `server.ts`、`config.ts`，加入生产原字节 `moderation.ts`、`native-moderation-hook.ts`、`native-terminal-policy.ts`。保留本地被动监控、native-controls 时间戳、协议可选字段；不调整当前协议20。
- [x] Node24服务器/协议215项回归及类型检查通过；3个审核模块及所有无关server源与运行manifest字节一致；独立审查无重要问题。
- [x] 制作带前置manifest、6文件补丁、离线模拟测试的首台专用源码包。包内3文件29项测试通过；准备脚本Bash/Python语法检查通过。
- [ ] 根据下一步实际部署配方准备备份/回退和启用脚本。当前源码包没有启用脚本，不可据此直接重建容器。镜像构建不得联网、拉基础镜像或安装依赖；隔离测试无生产数据挂载及网络。
- [x] 准备用户控制台 `scripts/prepare-ubuntu-monitor-pilot.sh`：私钥仅留Ubuntu，输出公钥及白名单部署摘要，完整容器配方仅root本地保存；不联网、不重启。
- [ ] 接收公钥后，在VPS设置限时只读该台专用配置包的授权，禁止交互/转发。正式启用前需关闭客户端并检查无活跃模型进程。
- [ ] 更新实际接入状态与验证记录。只有真实节点自然事件上报成功才标记全链路接通；未收到时保持待验证，不触发Claude/JEV测试请求。

本轮只涉及 ubuntu-cc；其余五台不部署、不登录账号。VPS管理服务本身无需更换。交付包、备份和临时身份文件属于私有运维数据，不提交Git。
