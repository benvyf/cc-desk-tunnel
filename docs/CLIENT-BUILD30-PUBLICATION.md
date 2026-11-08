# CC Space 0.3.10 / Windows Build 30

2026-11-06（香港时间）。用户指定将最新 `main` 的 `f126a7f` 打包，并替换 VPS CC 管理中心旧安装包下载入口。实际功能源码保持 `f126a7f`，仅新增 Build 号提交 `187f3ce3c1861ab7ed03baec663eb65ab2a4a728`：应用版本 0.3.10、Build 30、协议 24。该干净提交为包内身份和签名索引的 sourceCommit。

## 已完成发布

- [Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/30/win32-x64/CC-Space-Setup-0.3.10-x64.exe)
- 大小：258,602,132 字节。
- SHA256：`4f858887c666e4b7788747c98adda33f64bb46f9a7d23f77a337b106bfd2551c`。
- Windows pilot 签名发布 revision 43；强制续期后 revision 44，有效期至 2026-11-09 12:17:47（香港时间）。续期服务使用精确 expectedRelease、干净源码及独立制品路径，真实 systemd 执行成功，两个续期 timer active。
- 管理中心状态 API 的当前下载版本为 Build 30，候选数为零。旧 Build 29 原文件保留且摘要复核一致，没有原位覆盖已签名包。

发布目录 `/root/.cc-update-admin/release-build30/`；干净源码 `/root/.cc-update-admin/source-build-30/`；备份 `/var/backups/cc-update-service/client30-publication-20261106T041701Z`。本地独立制品在 `artifacts/windows/build30/`，常规打包输出的同名文件属于构建暂存，不作为旧线上制品覆盖使用。

## 内容与配套

包含 `f126a7f` 的多设备项目、侧栏计数和 SSH 项目选择改进，以及终端状态图标、本地查找、阅读保护、客户端恢复、快捷键设置说明与跨协议完整包入口。独立客户端更新控制器、IPC/preload、固定发布源/公钥、安装身份、配置目录和更新账本保留。

应用版本不变但 Build 更高；Build 28/29 的协议 24 客户端可从既有客户端入口检查更新。更旧协议仍需要配套升级，关闭任务和全部窗口后保留原范围/目录覆盖安装。不能承诺缺少更新能力的旧客户端得到远程注入修复。

**本次仅发行 Windows 客户端。** 服务端侧输出合并等源码改进没有通过本客户端包部署到 Ubuntu；现行 Linux 索引仍为 Build 14。客户端继续要求协议 24 的配套服务端。Claude、SDK、账号和模型网络路径不因安装包发布而改变，未调用真实模型或处理生产凭据。

## 验证证据

- 真实打包程序离线启动通过；从实际 NSIS EXE 解包后，app.asar 与已核验打包目录摘要相同；解包所得程序再次通过离线启动、preload 和组件回收测试。没有安装到用户当前 CC Space 目录。
- 包内 Build 30 / 协议 24 / sourceCommit 正确，28 个主进程模块和 691 个捆绑组件文件与发行源码/组件源一致；更新完整包入口实际进入包内 JS，搜索 MIT 许可保留，未发现客户端包新增模型 SDK/CLI 运行依赖。
- 核心更新/签名契约最终 42/42 通过；真实 NSIS 目录/标识钩子测试 2/2 通过；最新侧栏计数与项目选择相关 UI 20/20 通过。
- 公网已签名索引经真实控制器产生状态：Build 29 / 协议 24 提示 available Build 30；Build 27 / 协议 23 保留目标信息并提供完整包地址，同时拒绝自动下载安装；模拟已安装 Build 30 返回无更新，手动获取后提示不丢失。
- 更新 UI 24/24 通过，包括登录前、网络失败重试、断开后登录保留、跨协议提醒和真实控制器状态、禁止自动安装等场景。原仓库旧更新测试夹具的 Proxy 将未定义 `ssh` 属性当成函数，使新 `useSshTargets` 误认为有 SSH API，首轮被中止；在 `.local/client30-update-fixture` 的隔离副本中明确 `ssh: undefined` 后完成验证。产品 preload 的真实 SSH API、打包程序离线启动均验证；没有为测试替换产品逻辑或重新构建不同源码包。
- 首轮核心更新测试 41/42，失败为子进程退出后临时目录清理的 Windows EPERM；该项单独重跑及最终完整 42 项均通过。记录实际结果，不将首轮写成全绿。
- 发布脚本在 VPS 验签并完整下载校验；本机从公网再次完整下载 258,602,132 字节，独立验签和 SHA256 匹配。签名私钥只留 VPS；这里的签名为受管更新索引签名，未新增 Windows Authenticode 证书签名。
- Windows stable、Linux 索引、管理中心运行清单、现有节点版本与作业均未变化，未重启管理中心或触发 Ubuntu 安装。发布前备份索引、续期配置及一致性数据库快照。

机器可读脱敏证据见 [发布证据](evidence/windows-build30-production-2026-11-06.json)。原始打包、失败/重跑、上传、真实包检查和隔离 UI 日志保存在本机 `.local/client30-*`，VPS 受保护发布目录保留签名/续期日志及备份信息。
