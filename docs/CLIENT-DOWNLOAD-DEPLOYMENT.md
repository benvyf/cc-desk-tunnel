# 完整客户端下载上线记录

2026-10-24（Asia/Hong_Kong）。用户已授权实现推荐方案并上线。管理中心下载区和 Windows 完整安装包已发布，未自动安装用户本机客户端，未升级其他 Ubuntu。

## 用户入口

- [管理中心 → 客户端更新](https://api.ghostapi.org/cc-updates/admin/updates)：登录后在“下载安装包”下载或复制链接。
- [Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/3/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe)：0.3.6／Build 3／协议 20，pilot 试点版。
- 安装包 201073995 字节，约 191.8 MiB。SHA256：`f82611b9422f06a34a1842b0a2ae8fbecd453c6dc259ec981720804c17921fd6`。

安装说明见[完整安装包说明](CLIENT-DOWNLOAD.md)。先退出 CC，保持原安装范围和路径覆盖安装。安装包包含现有随包 OpenSSH 和 PowerShell，不包含用户配置、Claude 登录信息或管理员凭据。

pilot 索引 revision 6，有效至 **2026-10-27 01:09:43 香港时间**。当前没有自动续期任务；到期后下载区停用该索引入口，管理员需用更高 revision 续期再刷新。stable 未修改；历史 Build 2 公开制品保留。

## 源码、构建与发布

从 VPS 保存的 Git bundle 恢复 Build 2 精确源码 `4a39bc35008707366949496f9219e9b68c8d0856`，以合并提交 `a0d9975` 纳入当前账号监控生产分支，再实现下载区并将构建号提高到 3。最终客户端与管理服务运行来源均为 **`1a345de8458cd174b653ed86ca1dc6724b1c3c7f`**。后续文档提交不代表不同的已发布运行版本。

使用 Node 24、现有 NSIS 完整打包流程和固定生产公开身份。逐项核对包内 `managed-build.json` 的 Build、版本、协议、源码提交、VPS 源和公钥；验证更新控制器、下载验签模块、安装助手及随包组件存在。

管理服务归档 `artifacts/cc-update-service-download-1a345de.tar.gz`，SHA256 `f3a5faac726e86a8c36b9bf3bd60efb03c6b9f1ba8f94ded7a7d10101c9c93a0`。32 个运行文件部署后逐一校验通过，独立管理服务 active。

源码 Git bundle 已留在 VPS `/root/.cc-update-admin/release-input/client-build-3-source.bundle`；发布用干净 checkout 为 `/root/.cc-update-admin/source-build-3`。生产私钥未离开 VPS。签名和发布通过已有发布工具完成，输出在 `/root/.cc-update-admin/release-output/pilot-build-3.json` 及其 `.evidence.json`。只清理本次成功发布的候选；当前候选数 0，公开制品和签名通道保留。

## 验证

- 完整回归 406 项：375 通过、31 按条件跳过、0 失败。
- 单独启用管理中心真实浏览器测试：28 项全部通过，包括下载、复制链接、过期自动停用、撤回及退出清空；移动布局无横向溢出。
- 类型、改动文件格式、源码索引、文档链接和差异检查通过；独立代码复核无阻塞问题。
- 实际打包 EXE 的隔离启动测试通过；不连接真实账号，不覆盖本机安装。
- 正式 HTTPS 签名索引、公钥验签、HEAD 大小、发布工具完整下载 SHA256 检查通过。
- 真实 Edge 从管理中心点击下载，完整保存 201073995 字节并计算 SHA256，与本机原始安装包及签名索引一致。复制下载链接、导航往返、手机布局、退出清理通过，页面脚本错误 0。

脱敏证据保存在本地忽略目录 `.local/client-download-production-evidence/`、`.local/client-build-3-integrity.json` 和 `.local/client-build-3-package.log`。未发起 Claude 额度查询、聊天测试或 JEV 试算。

## 备份与回滚

管理服务上线前的一致备份：`/var/backups/cc-update-service/client-download-20261023T170606Z`，包含原运行目录、配置、unit、Nginx 配置及停止独立服务后的完整数据目录。原运行目录另存 `/opt/cc-update-service.previous-client-download-20261023T170606Z`。

部署时验证 `state.sqlite`、`moderation.sqlite`、`monitor.sqlite` 的逻辑内容、私有身份与完整配置保持一致；只替换管理页 HTML/JS/CSS 和文档，原 API、安装器、存储、审核及账号监控源码字节一致。随后发布 Build 3 对更新库的写入属于本次授权发布。

仅撤销下载页面时，停止 `cc-update-service` 并恢复上面原运行目录，再启动；保留当前配置和业务数据。不要用部署前数据覆盖后续账号上报和新的发布历史。客户端若需撤回／回退，应走更高 revision 签名撤回或更高 Build 的重新构建，不覆盖既有公开 EXE，不伪造旧构建身份。
