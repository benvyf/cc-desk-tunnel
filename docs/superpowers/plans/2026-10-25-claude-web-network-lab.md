# Ubuntu 隔离画面联调执行计划

> 已暂停：用户改选[本地浏览器与 Ubuntu 出口](../specs/2026-10-25-local-browser-remote-egress-design.md)，不再继续旧RFB联调和测试包传输。后文保留历史执行记录，尚未部署到Ubuntu。

沿用已审定的网页嵌入方案和用户“继续下一步”的授权，本次落实预检文档中独立合成 RFB 联调；不启用真实网页，不改生产服务、审核、浏览器、登录目录或公网监听。

**Goal:** 用现有 Docker 镜像运行当前 CC 服务源码及独立蓝色画面，准备客户端经 SSH 验证像素与输入。

**Architecture:** 新建 internal Docker 网络，只有服务及合成 RFB 两个容器；RFB 使用固定别名 cc-claude-web，端口仅在隔离网络可见；测试 CC 的 TLS 端口只发布到 Ubuntu 127.0.0.1:18789。源码只读挂载，数据写入 tmpfs，临时凭据独立生成，45 分钟退出。直接调用 createProxyServer 的模拟模式，不读取生产配置，也不使用原容器的 /data 或 profile。这里没有真实账号、模型或 CLI；生产审核门禁保持原样。

**Tech Stack:** Node24、现有 ws/RFB 测试 peer、Docker、OpenSSL、Bash。无镜像下载或构建。

- [x] 先写脚本回归，验证缺少运行器时失败。
- [x] 新增 scripts/claude-web-lab.ts，复用完整服务与离线 framebuffer；测试 TLS、认证、像素和输入。
- [x] 新增 scripts/start-claude-web-lab.sh：先检查名称/端口/资源，创建 internal 网络和两个受限容器；失败只回收本次资源。
- [x] 新增 scripts/package-claude-web-lab.mjs：按显式源码列表打包，不含 node_modules、配置、profile 或凭据；产物位于 .local。
- [x] 新增 docs/claude-web-network-lab.md，记录启动、SSH 转发、证书指纹、停止与验证边界。
- [x] 执行脚本回归、原门禁测试、Bash 语法、类型检查及相关真实 Electron 测试；检查打包内容。
- [ ] 根据用户选择的客户端运行位置提供传输与启动步骤。远端 Windows 可直连 Ubuntu SSH；当前本地 Windows 的路由尚未确认，不假定互通。

用户已选本地 Windows；实测直连Ubuntu私网IP的SSH3秒超时，Coding现有SSH禁用TCP转发，不能直接复用。新增本地独立profile预览入口scripts/open-browser-lab-preview.ps1；其语法检查通过，但未启动预览或连接远端。正在等待用户说明是否还有SSH跳板或私网VPN；测试容器启动也尚未执行，不开放新公网端口或改动现有SSH限制。

运行命令：`node --test scripts/claude-web-lab.test.ts apps/server/test/browser-service.test.ts`；`node node_modules/typescript/bin/tsc --noEmit`；`bash -n scripts/start-claude-web-lab.sh`。现有 Electron 验证为 `node node_modules/@playwright/test/cli.js test apps/desktop/test/claude-web.spec.ts`（Windows，Chrome）。

本地验证无法代替实际 Docker 网络、远端客户端或 Claude 出口验证；真实 Ubuntu 结果待用户执行后回传。

验证记录：19项Node回归通过，4种Shell模拟场景通过（就绪、同名拒绝、非internal拒绝、未就绪清理）；Bash语法和类型检查通过。真实Chrome/Electron的3项Chat回归通过，包含正式IPC像素和输入往返。首次新测试误用connected首帧断言，实际协议为ready，核对后已修正；打包首次因现有源码中的managed-server-loader.mjs被扩展名白名单拒绝，已允许源码.ts/.mjs并重新生成。归档含53个源码/说明文件及清单，无依赖和登录数据；Docker实测尚待执行。
