# 定制更新隔离验证记录

日期：2026-10-23。源码基线：`e2ec3dbecf1ac0b58ea2fc2a553f18d36b8a3d32`，分支：`codex/managed-updates`。

## 结果

- 使用 Node v24.19.0，`npm ci --ignore-scripts --prefer-offline` 完成锁定依赖安装，未修改锁文件。此方式没有安装 Electron 运行时或构建原生组件。
- 受影响单测有先失败再通过的记录；核心回归批次 45 项通过。新增管理脚本回归实际通过 Bash 调用两个退役命令，验证在读取部署配置前拒绝。
- 最终 `npm test`：319 项，273 通过、0 失败、46 跳过。跳过项受当前平台及缺少配套 OpenSSH、PowerShell、原生组件等条件影响，不代表它们已通过。
- 第一次完整测试中，未修改的隧道关闭测试曾因 WebSocket 关闭码 1005/1006 差异失败。隧道测试单独重跑 18/18 通过，最终完整测试通过；未修改隧道实现或测试以掩盖该结果。
- TypeScript `--noEmit`、全仓 Prettier 检查、Git 空白检查、部署 Bash 语法检查通过。
- Chrome 上运行 `managed-updates.spec.ts`：2 项通过，覆盖伪造更新广播与协议不匹配界面。
- Vite 前端构建通过；`stageDesktop` 实际构建并核对 Electron 主进程和新增 IPC 策略模块均进入暂存目录。构建仅有既有的大 chunk 提示。
- `package-server.mjs` 实际生成含配套 Web 页面的服务端源码归档。该归档仅用于本地验证，不是正式发行。
- 独立只读审查提出的官方安装链接和失效管理命令问题已修复，复查无剩余阻塞项。
- 暂存本次明确文件后，`node scripts/check.mjs` 通过：检查 258 个索引文件、workspace 清单、文档链接及秘密忽略规则。

## 验证边界

没有运行 Linux Docker 镜像构建或部署生命周期测试，没有运行真实 Electron 主进程的 IPC 集成测试，也未制作/安装 Windows EXE。Electron 注册由单测、源码审查及实际暂存内容核对覆盖。

没有连接模型、迁移六台生产服务、改变 GhostAPI、发布 Releases 或实现内容审核。现有服务协议 19 与源码协议 20 的配套迁移仍待实际版本采集和试点验证。

本地完整日志位于忽略的 `.local-*.log`，不纳入源码提交。
