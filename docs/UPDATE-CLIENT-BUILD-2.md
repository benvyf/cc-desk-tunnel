# Windows build 2：VPS 身份与 pilot 发布记录

2026-10-23 11:03（香港时间），首个 pilot 安装包已发布。用户授权重新生成生产身份，并将私钥及管理令牌集中保存在 VPS，以便跨电脑继续。

| 字段 | 值 |
| --- | --- |
| 源码仓库 | https://github.com/benvyf/cc-desk-tunnel.git |
| sourceCommit | `4a39bc35008707366949496f9219e9b68c8d0856` |
| 应用版本 / build | `0.3.6` / `2` |
| 协议 / 平台 | `20` / Windows x64 |
| 通道 / revision | `pilot` / `3` |
| 签名身份 | `managed-vps-2026-10-23` |
| 索引有效期 | 2026-10-26 11:02:19（香港时间） |
| 文件名 | `CC-Desk-Tunnel-Setup-0.3.6-x64.exe` |
| 大小 | `201074700` 字节 |
| SHA256 | `64adfa3702777cae467aa1325e79ad7ce091f7eb304e1b906a0d0b7bcf096c6f` |
| Windows 代码签名 | `NotSigned`；更新索引已进行独立 Ed25519 签名 |

[pilot 索引](https://api.ghostapi.org/cc-updates/v1/channels/pilot/win32-x64.json) · [安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/2/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe)

## 身份与制品

生产私钥和令牌在 VPS `74.82.201.214:/root/.cc-update-admin/` 生成及保存；目录 0700，文件 0600，root 所有。实测 `ccupdates` 和 `www-data` 均不能读取私钥和令牌。本机仅取得公开身份、签名索引和脱敏证据，未下载生产私钥或令牌。当前公钥、取用路径及跨电脑发布命令见 [VPS 统一发布说明](VPS-RELEASE-CREDENTIALS.md)。

旧电脑私钥不可用，按用户授权退役旧身份。先用新密钥将 pilot 和 stable 重签为空 revision 2，再从更新服务移除旧公钥；未删除数据库、build 历史或已有制品。旧 build 1 从未发布，仍保留本地历史记录，不复用该 build。客户端由干净提交重新打包，内嵌新公钥及 build 2；版本和协议不变。

## 已完成核对

- Windows 实际打包脚本退出码 0，打包程序启动测试 1/1 通过。包内身份与生产配置一致，安装助手未改变；未将源码、开发凭据或测试文件放入归档。
- 签名工具的六项核心测试通过；新发布命令完成了真实空通道签名、候选创建、激活，以及正式制品的签名、上传和激活。
- 在 VPS 上完整下载实际 HTTPS 公共安装包，大小和 SHA256 与本机构建一致。当前电脑独立验签公开索引，核对其与签名输出逐字节一致，并验证安装包 HEAD、206 Range 及对应本地文件字节。
- pilot 发布前后 stable 字节完全一致，保持新密钥签名的 revision 2 空通道，未向 stable 推广。

本地制品与证据：`artifacts/managed-build-2-4a39bc3/`，包括 `build-evidence.json`、`SHA256SUMS.txt`、`build.log`、`pilot-build-2.json`、`pilot-build-2.json.evidence.json`、`identity-retirement-evidence.json`、`public-access-evidence.json`。制品目录被 Git 忽略，跨电脑优先使用 VPS 上的制品与发布记录。

VPS 保留 `/root/.cc-update-admin/source-build-2/` 的干净源码及 `release-input/build-2-source.bundle`、安装包和模板；签名索引、发布证据在 `release-output/pilot-build-2.json` 及 `.evidence.json`。这些目录不作为网站路径暴露。

发布完成后通过管理 API 删除已完成候选，确认公开索引未变化、候选数为 0；最终状态另存 VPS `CURRENT-RELEASE.json` 和 `release-output/pilot-build-2-final-state.json`，后者也已复制到本机制品目录。

## 后续边界

### 当前 Windows 正式安装验收

用户已授权开始正式安装和更新流程验收。2026-10-23 12:14（香港时间）安装前检查确认：系统注册的已安装版本仍为 0.3.5，程序在 `D:/cc-desk-tunnel/CC Desk Tunnel/`；当前运行的 build 2 来自独立 win-unpacked 目录。正式安装包大小 201074700 字节，完整 SHA256 与本记录一致；实时 HTTPS pilot 索引使用固定新公钥验签通过，revision 3、build 2、源码、大小及 hash 相符，公开安装包 HEAD 大小匹配。以 build 2 身份调用更新契约返回 `current`，这是签名及候选判断检查，尚非已安装客户端的界面验收。

原 `%APPDATA%/CC Desk Tunnel` 和独立验收配置中的设备 ID 一致，保存的地址、指纹、模式和自动登录设置一致；令牌密文未输出或改写。两个配置的定时任务数均为 0。安装前记录了原 settings、草稿及任务文件的 hash，未修改这些文件。安装器使用交互 NSIS，安装结束不自动运行，配置位于安装目录之外，卸载配置为不删除用户数据。

用户已回报“已安装，未启动”。2026-10-23 12:16（香港时间）安装后检查通过：原目录中实际 app.asar 的版本为 0.3.6、build 2、协议 20，源码提交和内嵌新公钥匹配；系统卸载注册项已从 0.3.5 更新至 0.3.6，仍为原目录的所有用户安装。没有发现运行中的 CC 进程。原 settings、草稿、任务文件的完整 hash 均未变，原设备 ID 保留。以实际安装身份再次核对实时 pilot 签名及更新候选，结果为 `current`，revision 3 有效。

下一操作：用户运行 `D:/cc-desk-tunnel/CC Desk Tunnel/CC Desk Tunnel.exe`（不再使用独立验收 user-data-dir），检查原连接、设备归属和历史保留，并在“关于与更新”确认 build 2 / pilot / 协议 20，手动检查更新预期显示“当前没有可用更新”。实际客户端界面及其 Chromium 网络栈查询结果待回报，不能由命令行验签代替。未续期或推广 stable，模型测试继续暂停。

本地检查脚本 `.local/windows-build2-install-acceptance.mjs` 提供 `preflight` 与 `verify-installed` 两个阶段，证据在 `artifacts/windows-build2-install-acceptance/`，均不进入 Git；脚本只读取安装文件/本机配置并查询 VPS 公开更新入口，不启动 Claude。

### 保持范围

`ubuntu-cc` 已备份并切换到协议 20，服务端认证和独立公网健康检查通过；真实 Windows build 2 的连接及历史读取已确认。独立验收配置已恢复本机原设备 ID，交付剩余验收步骤后用户回报“暂时没问题”，各项未逐一确认，模型测试仍暂停；见 [单节点迁移记录](UBUNTU-PILOT-MIGRATION.md)。其余五台仍为协议 19，继续使用旧客户端。旧 build 1 不信任新密钥，需人工使用新引导包。

索引到期前需要通过 VPS 续期；目前没有自动续期任务。用户已明确不需要将 ubuntu-cc 回滚备份保存到另一台机器，并要求其余五台因暂时没有 Claude 账号可用而暂不处理；当前工作集中于 ubuntu-cc 和 Windows 客户端。stable 推广、关键词/JEV 审核和统一登录不在此次发布中。VPS 外的加密灾难恢复备份尚未创建。
