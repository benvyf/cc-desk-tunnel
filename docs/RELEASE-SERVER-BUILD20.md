# Linux Build 20：修复升级归档下载错版

2026-11-07，香港时间。Linux pilot 已发布 Build 20 / 0.3.10 / 协议 24，配套客户端仍为 Windows Build 32；没有重发客户端或操作用户 Ubuntu 节点。发行源码 `4d5d507410cb4dd4fd1896eed8ec2174a7017861`。

## 原因与修复

用户在 ubuntu-cc 执行 Build 19 升级，脚本于 `helper.py:267` 报 `Archive hash/size mismatch`。确认 Build 19 的目标签名正确，但迁移脚本仍硬编码下载 Build 18 的归档；原先的模拟下载不区分 URL，发布验证只核对 agent 选路和签名准入，遗漏了该脚本内部的第二次下载。这是发布缺陷，不是据此认定用户网络或缓存异常。

先增加实际 URL 断言，在断网 Linux 容器复现失败；另运行已发布 Build 19 签名脚本的真实 HTTP 下载、验签和解包，复现与用户相同的错误。Build 20 将归档下载地址、候选镜像标签和临时目录统一绑定到 `BUILD`，不再硬编码旧版本；加入已发布 Build 19 的精确描述符/依赖锁基线，保留 Build 16、18 等既有准入。旧 Build 19 归档及指令不原位覆盖。

默认空间清理、预算、空闲校验、受控断开、冷备份、健康检查、失败恢复与上一套必要回退保留。Claude、SDK、账号、管理员策略和模型出口不改。

## 历史备份摘要提示

用户同时报告 `Required cold-backup checksum does not match`。这表示当前必要回退的 `data.tar.gz` 与其 `record.json` 中 `archiveSha256` 不一致；现有日志不足以判定是文件异常还是记录异常，本轮没有访问该 Ubuntu 文件系统，不能声称已经修复该备份。

保留遇到此情况时中止历史备份退役、保留回退文件的行为。Build 20 的提示增加备份绝对路径、预期和实际 SHA256；不自动重写摘要、不删除该备份、不跳过升级时新建冷备份及校验。失败日志显示尚未进入服务切换，但不将此描述成已独立验证 Ubuntu 当前健康。

## 验证及发布

- Linux 隔离容器：迁移、空间/清理及备份轮转 30 项通过，包含实际 URL 断言和备份摘要诊断。发布/打包/准入测试 11 项通过，1 项仅 Linux root 的条件用例在 Windows 跳过；打包测试旧夹具缺少运行级别字段，仅修正夹具使用 `RUNTIME_LEVEL`，不修改已发布包。
- 236 个归档文件校验；发布前签名预览准入、发布后公开索引独立验签、本机制品摘要及 VPS 完整公开下载摘要通过。
- **本轮补上真实迁移下载路径验证**：实际执行 Build 20 签名脚本的 HTTP 下载、签名验证及严格解包，确认下载的是 Build 20 且摘要匹配。在第二次空间检查处主动停止；Docker/节点身份、空间与任务探测使用替身，没有执行 Docker 构建、停机、安装或模型调用。该验证不冒称完整节点升级演练。
- 管理中心现行 agent 针对已读节点及 Build 18/19 状态均选中 Build 20 新签名入口，实际签名准入通过；节点当前状态和既有作业未被本轮更改，未下发新任务。
- Linux pilot revision 34；精确续期已更新至 Build 20，新增 `runtime20.conf`，指向 `/root/.cc-update-admin/linux-build20-preparation/source` 的干净源码。强制续期、真实 systemd 单元和两个 timer 正常。该源码为运行引用，不可清理。
- Windows Build 32 索引及续期登记、stable、管理中心运行文件保持；旧公开制品不覆盖。发布备份 `/var/backups/cc-update-service/server20-publication-20261107T070159Z`。

[结构化证据](evidence/server20-download-fix-2026-11-07.json)。[Build 20 归档](https://api.ghostapi.org/cc-updates/server/v1/artifacts/20/linux-x64/cc-desk-tunnel-server-0.3.10-build20.tar.gz)，SHA256 `fc0dfb799c392799f03f41f99536b30d9620ebd427c4e434938593feea20688d`。

## 用户操作

刷新[管理中心](https://api.ghostapi.org/cc-updates/admin/updates)，为 ubuntu-cc 生成 **Build 20** 的新升级任务/指令，勿重试旧 Build 19 指令。不需要重新接入、重装或重登 Claude。客户端 Build 32 可继续使用。若仍提示历史备份摘要不一致，保留新日志中的具体路径和两侧摘要以进一步排查，不删除备份或手动改写记录。
