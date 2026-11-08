# 终端体验发布记录（2026-10-29）

## 已完成

- 终端实现、两轮审查修复及发布配置已提交、推送并快进合并到 `main`。
- Windows 与 Linux 包均来自 `aa64ea8f97d5dfa4564fbbadc6ad9cb73ce8a5f5`，版本 0.3.7，协议 22。
- Windows pilot：Build 21，索引 revision 23，安装包 201177722 字节。
  - SHA256：`0403b9fb54228c306062026d39802ac802945e525db3c41d8b2aa10b6942be6c`
  - 下载：https://api.ghostapi.org/cc-updates/v1/artifacts/21/win32-x64/CC-Desk-Tunnel-Setup-0.3.7-x64.exe
- Linux pilot：Build 7，索引 revision 10。
  - SHA256：`cbd1dc6636d189377a7b25c2c5d03ffe300afa2afa288f97080c0f316a2450b2`
  - 下载：https://api.ghostapi.org/cc-updates/server/v1/artifacts/7/linux-x64/cc-desk-tunnel-server-0.3.7-build7.tar.gz
- VPS 管理服务已部署 `058c9c96afe4d9949ffd8ea404fbfeb5fba7f27f`，服务端下载页新增“基础镜像升级（ubuntu-cc）”命令。该管理页更新不改变上述安装包的源码身份。
- 自动续期登记已切换到两个新版本；两项续期检查返回 `not-due`，定时器与管理服务均为 active。Windows stable 索引保持原样，发布候选已清理。

## 验证

- 发布前已有终端 Node、浏览器和真实 Electron 回归通过，详见终端实现状态文档。
- 本轮发布相关 36 项 Node 回归通过，4 项基础镜像脚本模拟测试在 Linux 通过。模拟测试不代表已在真实 Ubuntu 上完成迁移。
- Windows 安装包生成成功，打包应用独立启动及退出清理 smoke 通过。
- 管理页命令测试、发布测试与 TypeScript 检查通过；命令测试只解析、编译嵌入 Python，不执行迁移。
- 发布工具核对完整 Windows 与 Linux 公开下载文件的 SHA256；另从 Windows 工作站使用内置公钥验证两个公开索引的签名和版本。
- VPS 管理代码升级前保存变更文件和 BUILD-INFO，配置哈希保持不变。备份：`/var/backups/cc-update-service/terminal-20261029T065109Z`。
- 发布与迁移命令证据保存在 VPS 私有目录 `/root/.cc-update-admin/terminal-release-21-7`，未读取输出签名私钥或管理令牌。

## 用户测试顺序

1. 保留已安装的旧客户端，通过应用“检查更新”确认发现 Build 21，然后下载安装更新。此次工作未替换本机已安装客户端，实际提示与安装仍待用户验证。应用显示版本仍是 0.3.7，应核对 Build 21。
2. 结束 Claude 任务，完全退出所有客户端连接及托盘。
3. 打开 https://api.ghostapi.org/cc-updates/admin ，在服务端下载页复制“基础镜像升级（ubuntu-cc）”命令，在已审查的 Ubuntu 控制台执行，并保持终端打开。
4. 脚本只接受已审查的 Build 4 基础镜像（其受管程序可能已是 Build 5/6）。先验证签名、包清单和离线启动，再冷备份并切换；失败尝试自动回退。等待 `UPGRADE_OK: Linux Build 7 / protocol 22`，保存输出的备份路径和回退命令，然后重新连接。
5. 基础镜像升级成功后，另行安排一个兼容的后续服务端版本，用客户端完成服务端升级测试；已经处于 Build 7 时再次请求 Build 7 只是“已安装”，不能证明完整升级链路。

Build 6 → 7 改变存储与协议兼容性指纹，需基础镜像迁移；原有 `manual-image-upgrade` 拒绝机制保留。此次未在真实 Ubuntu 节点执行迁移，未发起真实 Claude 请求或修改账号认证。
