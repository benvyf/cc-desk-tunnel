# 配套服务端发布记录（2026-10-24 香港时间）

已更新 VPS 管理中心并发布 pilot 试点客户端、配套 Linux 服务端。第一台 Ubuntu 尚未执行首次接入；本机客户端和其他节点没有自动升级。

## 发布身份

- GitHub 最新分支已重新核对：`codex/vps-update-channel` 为 `9f783b25d8ed0c2395af9e16bb484a46a19bb402`，`codex/managed-updates` 为 `fd6e2130ccff8070d3349963c0997b2b21b9f79d`，均包含在发布源码中。
- 两个不可变安装包源码：`b05f6644105cbc56e0b50b93101cf51a860b9931`，应用版本 0.3.6、协议 20。
- Windows x64：Build 4，201080059 字节，SHA256 `827dc2335ec1f0116f2ca0645e0f7a3c5a7bbce3d60a641a566ba779b42ba5d9`。
- Linux x64：Build 1，1563692 字节，SHA256 `7ae059abd1e178e71b81bc9a7f61f07deb49a637ceba7e09f1ebd21fe408b306`，描述文件 SHA256 `70892d6b970d505452f5250c3ee1ee3dbe1acfe28f38809933e8368168a09fa8`。
- Linux 固定运行环境 `node24-cli2.1.295-v1`；包内是完整程序、配套 Web、部署文件和 inventory，不包含账号、依赖、环境凭据或私钥。
- 管理中心随后单独修复手机页面长摘要换行，运行源码为 `a16ba6f8418425fd5ada9e51928016235b6a3bb4`；42 个运行文件哈希、root 所有权和 0644 权限核对通过。仅 CSS 和构建清单变化，两个已发布安装包保持原样。

## 下载与接入

- [管理中心客户端更新页](https://api.ghostapi.org/cc-updates/admin/updates)：登录后下载客户端、服务端或复制首次接入命令。
- [Windows Build 4 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/4/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe)。
- [Linux Build 1 完整程序包](https://api.ghostapi.org/cc-updates/server/v1/artifacts/1/linux-x64/cc-desk-tunnel-server-0.3.6-build1.tar.gz)。

首次命令只支持已审查的第一台 `ubuntu-cc`。先结束任务、关闭 CC，再在该 Ubuntu 控制台运行页面中的命令。安装器固定校验现有源码、运行环境、签名和目标摘要，保存冷备份及离线回滚脚本。之后遇到协议不匹配，新客户端提供“升级配套服务端”，展示目标并由用户确认；运行环境或持久化实现不兼容时要求人工镜像升级。

没有该 Ubuntu 的 SSH 管理入口，因此本次未在那里执行命令。模拟失败恢复和隔离镜像验证不等于已在实际节点演练升级或回滚。账号监控继续复用正常使用过程中已有的账号／额度结果；本次验证没有调用 Claude、JEV 或额度接口，也没有启动真实原生终端。

## VPS 恢复与续期

- 运行目录、配置、单元、Nginx 和冷数据备份：`/var/backups/cc-update-service/server-distribution-20261023T192644Z`。
- 原运行目录：`/opt/cc-update-service.previous-server-distribution-20261023T192644Z`。失败恢复程序文件时保留当前业务数据。
- 样式和构建清单备份：`/var/backups/cc-update-service/server-download-style-20261023T193124Z`。
- 旧续期配置和 loader 备份：`/root/.cc-update-admin/automation-backups/2026-10-23T19-27-53-156Z`。
- 已核对配置、私有身份和 `state.sqlite`、`moderation.sqlite`、`monitor.sqlite` 的逻辑内容在运行包部署时保持一致。
- 修正原 Windows 续期仍指向 Build 2 的过期配置，现固定到 Build 4 的干净源码与独立制品路径。Linux 使用独立续期配置和单元。
- 两个续期命令均强制执行成功，systemd 沙箱单元也成功；两个 timer 均 active。最终 Windows revision 8、Linux revision 2，候选数 0，stable 索引字节保持不变。
- 签名私钥和管理令牌始终留在 VPS；运行配置未更换。

## 验证证据

- 最终 Node 24 全量：493 项，461 通过、32 跳过、0 失败；TypeScript 和相关格式检查通过。
- Python 本地：bootstrap 13 通过、1 POSIX 跳过；监控安装器 5 通过。新增 Linux 权限及实际嵌入 Node 状态检查回归 2/2 通过。
- 实际 Windows 打包进程启动、预加载、随包组件关闭清理测试通过；归档内 Build 4 身份、升级 IPC、共享签名验证器及组件齐全。
- 最终 Linux 归档通过真正 Docker COPY 后的监督程序状态、health、SIGTERM 检查，网络隔离、无账号挂载、只读、UID 1000，CLI 调用 0 次。
- 公开 HTTPS 索引签名、HEAD 长度、Windows 发布下载哈希、浏览器实际 Linux 下载哈希、安装器哈希均核对通过。管理页复制命令、退出清除、390px 手机无横向溢出、无页面错误通过。
- 浏览器加载真实公开资产和下载；管理元数据通过只读 SSH 在 VPS 内认证后交给浏览器，未把真实管理令牌放到浏览器测试中。此检查不等于演练真实密码登录。
- 本地脱敏证据：`.local/client-build-4-integrity.json`、`.local/build4-full-regression.log`、`.local/client-build-4-package.log`、`.local/managed-server-production-evidence/verification.json` 和该目录截图。最终证据 `localStyleOverride=false`。
- VPS Linux 镜像验证：`/root/.cc-update-admin/release-input/final-server-package-smoke.log`；实际 bootstrap Dockerfile 权限验证：`/root/.cc-update-admin/server-task3-tests-20261024/bootstrap-directory-permission-image.log`。
- 干净发布源码及原始 Git bundle 保存在 VPS `source-build-4` 和 `release-input/managed-release-build4.bundle`；发布签名与证据位于 `/root/.cc-update-admin/release-output/`。
