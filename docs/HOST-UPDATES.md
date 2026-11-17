# Ubuntu 设备更新按钮

管理中心「账号监控 → 我的设备 → 更新设备」统一处理宿主机程序、业务程序和基础镜像更新，每台设备分别确认一次。

## 首次接入

1. 在目标设备面板点击「生成宿主机接入命令」，复制命令。
2. 在对应 Ubuntu 宿主机控制台执行。需要 Ubuntu 24.04、Python 3.12、OpenSSL、Docker 和 sudo。命令与主机名绑定，十分钟有效且只能使用一次。
3. 返回管理中心，等待「宿主机更新通道在线」和当前版本出现。安装通道不会自动更新 CC 服务。

首次接入命令适用于所有已配置且尚未接入的设备，接入范围仍按实际运维授权执行。本批 ubuntu-cc、ubuntu-cc-02、ubuntu-cc-03 的旧通道迁移仅支持已知的 Build 20 镜像加已签名 Build 21 活动程序，或 Build 21 镜像；其他基线不自动套用。

## 日常更新

先结束运行、后台和等待审批的任务，并关闭原生终端。在面板确认目标设备、版本和摘要后提交更新，目标设备主动领取并上报进度。基础镜像升级先清理未使用构建缓存、检查容量、准备候选并离线预检，构建后再次清理缓存并复查容量。旧服务在准备阶段继续运行；最终检查空闲后，自动断开客户端并阻止重连，再执行冷备份和切换。

支持新维护入口的普通程序更新也会先准备、再检查活动并自动断开空闲连接；旧服务端不具备此能力时，仍使用原严格安装接口，需要先手动退出客户端。维护入口只接受本机回环请求及现有完整服务凭据，桌面短期授权不能使用该入口。普通严格安装接口的默认准入规则不变。

不会强制终止任务、等待审批或原生终端，也不会删除镜像、容器、卷、业务数据或回退资源。磁盘仍不足时显示所需、可用和不足字节；备份盘与数据恢复盘分开检查。仅下载遇到临时网络错误时最多尝试三次，不自动重复安装、切换或回退。

普通更新复用现有服务端更新准入、签名校验和回退流程。当前旧通道采用已签名的 Build 22 / runtime v4 桥接发布，迁移程序与目标版本绑定，执行已审核的清理、冷备份、迁移和恢复步骤。不兼容的基础镜像发布必须在已签名且完整校验的服务端归档中携带 `deploy/host-update/apply.py`，接受 `--release <release.json> --install`；没有该迁移程序时拒绝自动执行，使用该版本的人工部署说明。普通程序更新无需迁移程序。

## 权限边界

宿主机更新程序由 root 管理，通过 HTTPS 主动连接管理中心，每约 15 秒轮询一次；执行期间约 5 秒报告一次。无需开放 SSH，也不把 Docker socket 或宿主机授权令牌交给 CC 容器或客户端。管理中心确认请求只能指定已发布版本和 SHA256，不能下发任意命令。设备自行验证发布签名、时效、发布身份和防降级条件。

- 稳定平台与版本化程序：`/opt/cc-host-platform`（旧通道兼容目录：`/opt/cc-host-updater`）
- 私有配置、持久任务回执：`/var/lib/cc-host-updater`
- 任务日志：`/var/lib/cc-host-updater/jobs/<任务ID>.log`
- 服务日志：`sudo journalctl -u cc-host-updater.service -n 100 --no-pager`
- 停用通道：`sudo systemctl disable --now cc-host-updater.service`（正在更新时会等待工作进程结束）

管理中心仅保存宿主机令牌的哈希；浏览器只获得一次性接入命令，不获得长期令牌。Nginx 需采用 `deploy/update-service/nginx.conf.example` 中的 `/cc-host/v2/` 入口，并保留 `/cc-host/v1/` 兼容旧通道。

以下接入与恢复说明仅适用于首次接入或首次接入结果不确定的情况。已安装稳定平台会拒绝重新接入；日常更新保留现有凭据，直接使用设备面板。首次接入先校验签名程序和安装目标，兑换接入码前不停止原通道。接入码被拒绝时保留原程序和配置；若中心已接受但响应丢失，旧凭据可能已失效，安装器会明确报告结果不确定，此时才按提示重新生成接入命令恢复首次接入，不触发应用升级。

首次接入安装器使用独立的接入锁，避免两次接入相互覆盖。兑换前下载并校验签名版本包、暂存固定程序并校验安装目标，预留凭据文件；中心接受后先持久化新凭据，再准备首次激活。新程序启动失败时按恢复记录恢复旧程序入口、unit 和启用状态，保留中心已签发的新令牌，不恢复已失效的旧令牌。若中心已接受但新凭据未能持久化，则保留原程序与现场，明确要求恢复首次接入，不宣称恢复成功。

签名程序按版本暂存，停止原通道前必须持久化首次激活意图及原 unit、启用和运行状态。候选程序只有通过与目标版本、摘要及本次实例身份完全一致的健康验证后才提交。中断后依据持久记录确认已提交目标或恢复原入口和服务状态；记录或身份不匹配时停止并保留现场，要求维护检查。

## 中断和失败

同一设备只能有一个待处理任务。未被设备接收的任务十分钟后失效，查看设备状态或重新生成接入命令时也会清理过期等待，不需要设备重新上线；通道离线时管理中心会显示等待连接。任务首次派发时即记录为已领取，避免执行过程中误按等待超时解锁。设备收到已经超过确认时限的任务会报告失败，不执行安装。已开始的任务不因页面关闭而取消。

宿主机进程或机器中断后，**不会自动重放更新**。若持久目标的 Build、协议、发布摘要及实际就绪状态均匹配，回报已完成；否则报告未完成并保留日志及恢复线索。只有旧服务恢复验证通过，才能报告已经恢复。重装通道前如检测到未处理的运行回执会停止安装，避免覆盖恢复线索。仅下载或仅启动不视为成功。

## 已接入设备采用新流程

已接入设备在各自面板点击「更新设备」，核对目标设备、版本和摘要后确认一次；系统按需更新宿主机程序、业务程序和基础镜像，保留现有宿主机令牌，无需重新接入或再次执行控制台命令。VPS 上更换代码本身不会触发设备更新；先确认旧作业已结束或完成恢复检查，再由用户逐台选择更新。

ubuntu-cc、ubuntu-cc-02、ubuntu-cc-03 的旧通道会在用户分别选择该设备的首次更新时自动迁移到稳定平台，再继续完成同次确认中的更新，不会自动批量迁移。新能力随经过签名的宿主机程序、服务端和基础镜像发布采用；不得修改任何已发布包或以同一编号替换其摘要。文件系统或磁盘故障需先另行维护，设备更新不会代替故障修复。

宿主机能力以实际 supervisor 上报为准，不能由新业务子进程单方面推断。已提交的持久阶段不能单独证明当前服务就绪：中断恢复还必须核对业务进程已实际退出维护。旧版本缺少这项证明时保守回报需要检查，不自动重放或误报完成。

普通更新与宿主机更新共用一个准备锁，防止并发入口互相释放维护状态。自动断连接口同时检查原始连接和反向代理后的实际来源，不能通过本机代理把远端请求当作宿主机请求。基础迁移会在冻结检查后、断网停服前复核容器配置和策略；暂停请求结果不确定时保留 admission 恢复记录，阻止下一次更新掩盖现场。

安全退出后的重试需要两项证明：supervisor 明确确认没有正在准备或切换的事务，且已提交的业务进程实际处于服务状态。满足时宿主机向中心报告可再次提交，但保留上一次任务的失败结果；仍需用户重新确认，不自动重放。旧 supervisor 或未就绪状态没有这项证明时继续拒绝自动重试。

离线回退会在停止候选服务之前检查恢复空间、解压并校验旧数据；恢复目录身份和阶段持久记录。数据保留或恢复放回途中中断时，重复执行原回退命令可识别已完成的步骤继续处理。未知目录不覆盖，新数据保留在原约定的 `.after-<备份名>` 路径。已暂停的候选容器不会重复请求暂停；检查失败时保留原来的暂停状态，成功时先隔离网络再解除暂停并停止。


## Log and workflow retention

The v2 worker attempts cleanup hourly after heartbeat, between local child processes. It skips a busy shared operation gate. Only private root-owned, regular, single-link files named exactly `UUID.log` in the protected fixed `jobs/` directory can expire after 30 days. Each pass examines at most 1,000 directory entries and removes at most 50 files; its directory cursor continues on the next pass. Current job, report, lastJob and references from fixed platform, adoption, original-app, image and recovery metadata are preserved, including recognized historical metadata snapshots. Existing `ownedJobs` anti-replay tombstones do not retain every historical log. Malformed, linked, unknown or unsettled recovery metadata prevents cleanup. Application data, backups, rollback records, configuration and version artifacts are never deleted.

The center keeps the existing 100-step workflow limit. After a successful heartbeat transaction commits, at most hourly, one SQL statement removes up to 50 independent terminal workflows older than 30 days. It preserves each node's latest workflow, nonterminal workflows, maintenance requirements, unadopted legacy workflows and all referenced retryOf, bridgeId and appJobId ancestors. SQL selects metadata without loading all workflow logs into service memory. Current state, observations, credentials and v1 jobs are untouched.

The service archive includes `cc-host-agent-index-renew.service` and `.timer`. The daily task renews only the exact archive pinned by `/root/.cc-update-admin/host-agent-renewal.json`, with up to 30 minutes of randomized delay and persistent missed-run handling. Operators install and enable the timer just as for server renewal; packaging itself changes no VPS or device and queues no upgrade.
