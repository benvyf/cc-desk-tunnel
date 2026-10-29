# 六台 Ubuntu 与搬瓦工中转：部署与维护手册

> 历史归档：本文记录 2026-10-22 起的部署状态，文中的“当前”指记录当时。后续邮箱登录、协议、Build 及升级记录以 [最新开发交接](../DEVELOPMENT-HANDOFF.md) 为准；不要直接用旧安装或恢复步骤覆盖已升级节点。

更新日期：2026-10-22（香港时区）。统一维护远端Windows `DESKTOP-MB2PIGK` 上的六台Ubuntu：第一台原机`ubuntu-cc`，以及`ubuntu-cc-02`～`ubuntu-cc-06`。文中“01/第一台”均指实际主机名`ubuntu-cc`，不要将它改名或误写为`ubuntu-cc-01`。

本文合并了原《五台Ubuntu与搬瓦工中转-进度交接与续做指南》、本次03～06实际部署结果，以及搬瓦工基础设置指南中的相关维护步骤。**今后以本文维护当前状态；旧文档中的“03～06待部署”已经过时。**

## 1. 当前状态与后续待办

**六台均有已部署的CC及搬瓦工入口。** 第一台为原有使用环境，已有客户端使用和链路测速记录；02依据此前健康/证书交接记录；03～06在本次操作中逐台完成，并由本地Windows独立验证公网HTTP 200和证书SHA256。02～06记录的健康结果为：

```json
{"status":"ok","protocolVersion":19,"adapter":"claude-code"}
```

| 项目 | 截至本次交接的结果 |
| --- | --- |
| 六台Ubuntu与公网入口 | 第一台原有环境保留，02～06已完成部署 |
| 第一台CC运行方式及数据目录 | 2026-10-22只读确认Docker部署，程序/部署配置位于`/opt/cc-desk-tunnel`，`/srv/cc-desk-tunnel`挂载至容器`/data`，容器healthy |
| 02～06 Docker与CC服务、Ubuntu到VPS反向隧道 | 已部署 |
| 六台公网健康与CC证书指纹 | 2026-10-22六台均在遥测配置修改后逐台核对：证书指纹匹配、HTTP 200、健康正常、协议19 |
| Claude非必要流量与CLI自动更新 | 六台均已切换为三个独立开关且移除总开关，配置核对与切换后公网健康通过。均保留CC本机OpenTelemetry配置，实际统计增长待验证 |
| 第一台订阅额度显示 | 移除总开关并启用三个独立开关后，用户确认CC额度恢复：5小时0%、每周7%；历史调用统计仍保留（第8.3.4节） |
| 开机启动配置 | 02～06 Docker与隧道已执行enable、VPS转发active/enabled；第一台隧道安装脚本有enable记录，当前状态未重新验收 |
| 本地CC客户端连接 | 第一台有实际使用记录；02～06尚未收到验收结果 |
| Claude登录、实际模型回复、Windows执行通道 | 第一台保留原环境，本次未重新验收；02～06暂缓 |
| 新机模型请求实际公网出口 | 尚未逐台核对 |
| Ubuntu重启、Windows重启及断电恢复 | 尚未实测 |
| 独立备份、RAM盘和旧安装残留清理 | 尚未收到完成记录 |
| 宿主机存储/数据完整性异常 | 根因尚未查清 |

后续顺序：先做独立备份，再逐台完成客户端连接、按需要配置模型与执行验证，最后逐台验证Ubuntu重启恢复及Windows宿主机启动恢复。已经安装的机器不再执行首次初始化。

本手册记录部署事实与操作方法，不承诺硬件问题已经解决。2026-10-22六台在遥测配置修改后的健康检查均返回协议19。查询发布页时最新版本为v0.3.5，但没有逐台读取最终安装包版本，因此不将所有机器的应用版本直接标为0.3.5。

## 2. 操作位置与访问方式

| 位置 | 识别方式 | 负责内容 |
| --- | --- | --- |
| 日常本地Windows | 使用CC客户端的电脑 | 客户端、项目文件、本地执行、VPS运维 |
| 本次文档工作区 | `D:\cc-desk-tunnel`，Windows用户`99794` | 本手册及本次VPS操作 |
| 远端Windows宿主机 | `DESKTOP-MB2PIGK`，用户`TOPC` | Hyper-V、虚拟机网络、进入各Ubuntu |
| 目标Ubuntu | 提示符如`benben@ubuntu-cc-03:~$` | Docker、CC、SSH反向隧道 |
| 搬瓦工VPS | `74.82.201.214`，root运维 | socat、公钥授权、防火墙 |

本次由用户在远端Windows打开PowerShell，再SSH到Ubuntu执行命令；本聊天通过本地已有密钥直接管理VPS。不能假定本地Windows能够直接访问远端Hyper-V的`172.28.*`地址。

### 2.1 从远端Windows进入Ubuntu

```powershell
# 示例：03；其余IP见第3节。
ssh benben@172.28.147.163
```

输入`exit`退出Ubuntu，回到远端Windows PowerShell后才能切换登录另一台。Ubuntu中的长脚本经SSH终端粘贴，避免使用Hyper-V“键入剪贴板文本”（此前曾产生乱码）。

### 2.2 内网IP变化时

在远端Windows的管理员PowerShell查看：

```powershell
$ccVmNames = @('ubuntu-cc') + @(2..6 | ForEach-Object { 'ubuntu-cc-{0:D2}' -f $_ })
Get-VM -Name $ccVmNames |
    Select-Object Name,State,ProcessorCount,MemoryStartup,AutomaticStartAction,AutomaticStopAction
Get-VMNetworkAdapter -VMName $ccVmNames |
    Select-Object VMName,SwitchName,IPAddresses
```

这些是Default Switch的DHCP地址，不是静态地址。`IPAddresses : {}`表示Hyper-V未收到来宾地址信息，不能据此认定Ubuntu断网。2026-10-22六台均为Running但地址报告均为空，02旧地址SSH超时，随后从控制台确认其新地址为`172.28.152.86`。不要因旧IP无法访问而重建虚拟机。

在远端Windows PowerShell打开对应控制台（示例为02；第一台名称为`ubuntu-cc`）：

```powershell
vmconnect.exe localhost "ubuntu-cc-02"
```

在Ubuntu控制台登录后执行：

```bash
hostname
ip -4 -br address
```

取`eth0`的IPv4地址，回到Windows PowerShell执行`ssh benben@实际地址`。确认主机名后再粘贴维护脚本；`docker0`或`br-*`的172.17/172.18地址不是本次Windows到Ubuntu的SSH目标。长脚本仍通过SSH粘贴。

### 2.3 VPS运维入口与两台本地电脑的区别

本次在`99794`电脑上实际使用并成功登录：

```powershell
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes `
    -i C:/Users/99794/.ssh/cc-hk-relay-ed25519 root@74.82.201.214
```

原交接另记录过`benben`电脑的入口：

```powershell
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes `
    -i C:/Users/benben/.ssh/vps_bandwagon_ed25519 root@74.82.201.214
```

后一入口是历史记录，本次未在那台电脑重新验证。文件名不同不代表需要重建VPS；使用当前电脑真实存在且已授权的运维密钥。远端`TOPC`电脑不一定有这些密钥。root运维密钥与Ubuntu隧道密钥用途不同，不互相复制替代。

## 3. 机器、端口与客户端参数总表

| Ubuntu | 最近内网IPv4 | 客户端WSS地址 | VPS回环端口 | VPS转发unit |
| --- | --- | --- | --- | --- |
| 01：原机`ubuntu-cc` | `172.28.149.26`（2026-10-22控制台确认） | `wss://74.82.201.214:8443/ws` | `127.0.0.1:28787` | `ccdesk-relay.service` |
| `ubuntu-cc-02` | `172.28.152.86`（2026-10-22控制台确认；旧地址172.28.152.159） | `wss://74.82.201.214:8444/ws` | `127.0.0.1:28788` | `ccdesk-relay-ubuntu-cc-02.service` |
| `ubuntu-cc-03` | `172.28.147.163` | `wss://74.82.201.214:8445/ws` | `127.0.0.1:28789` | `ccdesk-relay-ubuntu-cc-03.service` |
| `ubuntu-cc-04` | `172.28.148.235` | `wss://74.82.201.214:8446/ws` | `127.0.0.1:28790` | `ccdesk-relay-ubuntu-cc-04.service` |
| `ubuntu-cc-05` | `172.28.148.113` | `wss://74.82.201.214:8447/ws` | `127.0.0.1:28791` | `ccdesk-relay-ubuntu-cc-05.service` |
| `ubuntu-cc-06` | `172.28.156.180` | `wss://74.82.201.214:8448/ws` | `127.0.0.1:28792` | `ccdesk-relay-ubuntu-cc-06.service` |

六台CC上游均使用`127.0.0.1:8787`。VPS公开的是8443～8448，28787～28792只监听回环，不向公网开放。SSH运维及隧道使用VPS的22/TCP。本次没有修改第一台8443配置或重新初始化02。

### 3.1 CC证书SHA256（客户端填写）

| Ubuntu | CC证书SHA256 |
| --- | --- |
| 原机（2026-10-22公网核对匹配） | `7C:08:EE:9E:AA:52:B3:9B:DA:F6:4B:63:FB:FD:BE:16:3B:46:14:51:9D:A3:15:C5:B5:F6:8A:1E:A1:83:A8:2E` |
| 02 | `71:2C:ED:7A:C3:EE:9D:AB:AF:51:D2:2A:D6:F2:27:9F:54:39:BD:F3:4F:D6:33:16:61:CC:21:D6:A0:1F:E5:EE` |
| 03 | `C1:4A:43:68:C1:83:12:98:1F:1D:2D:51:1D:1D:6C:43:C3:CB:C7:4A:48:9A:C1:7E:E4:10:2F:00:D4:58:36:E8` |
| 04 | `2A:3A:37:45:E4:AB:E5:BB:A2:97:98:E2:63:6B:86:30:CB:81:5D:EB:05:75:98:DC:A2:71:B8:9A:8E:49:FA:A0` |
| 05 | `AE:77:2D:B9:D8:D0:F9:2C:25:36:24:76:D4:69:B5:93:E4:BE:97:29:8C:8E:B1:C1:4A:4E:55:74:D0:96:A1:FE` |
| 06 | `E1:B6:EC:47:78:C5:C3:8A:D9:1B:EC:24:D3:E2:E2:99:FB:FE:BC:C5:37:33:9A:B2:3E:22:FA:A4:53:1D:3B:04` |

证书续期或替换后应同步更新本表与客户端。原机指纹与旧指南记录一致，已于2026-10-22在公网核对；后续若发生变化，以可信SSH通道读取到的实际证书为准。

### 3.2 三种凭据的区别

| 类型 | 用途 | 保存位置 |
| --- | --- | --- |
| CC服务凭据`PROXY_TOKEN` | 本地客户端连接某一Ubuntu | 02～06为`/srv/cc-desk-tunnel/config/service.env`；第一台从实际部署配置读取 |
| SSH隧道私钥 | Ubuntu向VPS建立反向隧道 | 第一台`/home/benben/.ssh/cc-hk-relay-test`；02～06为`/home/benben/.ssh/cc-bwg-relay` |
| Claude账号/API凭据 | Claude Code调用模型 | 各台实际持久数据中的原生登录状态或提供方配置；第一台目录先核实 |

每台保持独立身份。本文只收录公钥、证书指纹和路径，不收录密码、私钥、服务token或模型key。

## 4. 链路与模型出口

```text
日常本地Windows：CC客户端、项目文件、PowerShell
       ⇅ WSS（对话、审批、执行通道）
搬瓦工74.82.201.214：对应844x公网入口
       ⇅ socat，双向TCP_NODELAY
搬瓦工127.0.0.1：对应2878x/2879x回环端口
       ⇅ Ubuntu主动建立的反向SSH
目标Ubuntu 127.0.0.1:8787：CC HTTPS
       ⇅
CC服务、Claude Code、原生会话数据
```

TLS在Ubuntu终止；VPS转发TCP字节，不保存Claude登录、CC会话或Windows项目。Ubuntu到VPS的SSH隧道用于公网接入；CC自身的执行通道用于操作日常本地Windows，两者用途不同。

模型请求的预期路径是Ubuntu/容器 → 远端Windows网络出口 → 模型服务。搬瓦工只中转CC连接，不会自动成为模型出口。Default Switch NAT通常使Ubuntu使用远端Windows的公网出口，但TUN、VPN或模型单独代理可能改变结果，需实际核对。

原机此前已关闭Funnel，本方案不要求日常本地Windows安装Tailscale。五台新增机器本次不涉及UU安装。

历史链路测速：第一台完整路径“本地Windows ↔ 搬瓦工 ↔ 马来西亚Ubuntu”最近记录约147ms，8MiB下载三次为10.26/32.31/40.51Mbps；这不是六台逐台测速，也不是带宽保证。VPS此前核实BBR+fq；socat的TCP_NODELAY已写入各转发unit。

## 5. 已落地文件与服务配置

### 5.1 02～06的共同目录与第一台区别

下表是02～06实际采用的Docker部署布局。第一台也已确认使用相同程序目录、Compose配置路径及持久数据挂载，但其隧道文件和主机端口绑定不同，具体见第5.6节。

| 内容 | 路径/配置 |
| --- | --- |
| 程序与管理脚本 | `/opt/cc-desk-tunnel`、`deploy/manage.sh` |
| Compose部署配置 | `/opt/cc-desk-tunnel/.local/docker.env` |
| 完整持久数据 | `/srv/cc-desk-tunnel` |
| CC服务环境与token | `/srv/cc-desk-tunnel/config/service.env` |
| Claude提供方配置 | `/srv/cc-desk-tunnel/config/provider.json` |
| HTTPS证书/私钥 | `/srv/cc-desk-tunnel/tls/control.crt`、`control.key` |
| 原生Claude数据、GUI状态 | 数据目录下的`home`、`state`、`workspace`等，整体备份 |
| 隧道密钥、公钥 | `/home/benben/.ssh/cc-bwg-relay`、`cc-bwg-relay.pub` |
| VPS已核实主机密钥 | `/home/benben/.ssh/cc-bwg-known-hosts` |
| Ubuntu隧道unit | `/etc/systemd/system/cc-bwg-relay.service` |

`.local/docker.env`关键值为`CONTROL_BIND='127.0.0.1'`、`CONTROL_PORT='8787'`，`CONNECTION_URL`按第3节逐台填写。不要把容器内部监听也改成回环；容器内仍需监听`0.0.0.0:8787`。不要硬编码其他机器的Compose项目名或容器名。

02已知项目名为`cc-desk-tunnel-96ccb91a`，容器为`cc-desk-tunnel-96ccb91a-proxy-1`；03～06由初始化独立生成。本手册优先使用管理脚本，不依赖这些随机名称。

### 5.2 Ubuntu常驻隧道模板

以下为03的已部署配置参考，不是要求在其他机器原样覆盖。02/04/05/06分别将Description中的主机名及`-R`的回环端口改为28788/28790/28791/28792，其余路径按本方案一致。

```ini
[Unit]
Description=CC Desk Tunnel reverse SSH for ubuntu-cc-03
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
User=benben
ExecStart=/usr/bin/ssh -NT -i /home/benben/.ssh/cc-bwg-relay -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UserKnownHostsFile=/home/benben/.ssh/cc-bwg-known-hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -R 127.0.0.1:28789:127.0.0.1:8787 ccdesk-relay@74.82.201.214
Restart=always
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

不同Ubuntu使用相同unit名没有冲突。原机历史隧道密钥为`/home/benben/.ssh/cc-hk-relay-test`，不要用新增机器的模板覆盖原机。

### 5.3 VPS服务模板

VPS隧道专用用户为`ccdesk-relay`，home为`/var/lib/ccdesk-relay`。以下是03的`/etc/systemd/system/ccdesk-relay-ubuntu-cc-03.service`：

```ini
[Unit]
Description=CC Desk Tunnel relay for ubuntu-cc-03
After=network.target

[Service]
User=ccdesk-relay
ExecStart=/usr/bin/socat TCP4-LISTEN:8445,bind=0.0.0.0,reuseaddr,fork,nodelay TCP4:127.0.0.1:28789,nodelay
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

02/04～06按第3节同时替换unit文件名、Description、公网端口和回环端口；第一台使用独立的`ccdesk-relay.service`、8443和28787。UFW已放行8443～8448/TCP。不向公网放行28787～28792或Ubuntu8787。

### 5.4 VPS公钥授权

授权文件为`/var/lib/ccdesk-relay/.ssh/authorized_keys`；`.ssh`权限700，文件权限600，属主`ccdesk-relay`。每台授权前先备份，逐行追加，不整体替换。03示例：

```text
restrict,port-forwarding,permitlisten="127.0.0.1:28789",permitopen="127.0.0.1:28789",command="/bin/false" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGB+BAephidz6Y15JCbZg1fB7XASKOdiktAaC3KMbiVf ubuntu-cc-03-bwg
```

六台公钥对照（第一行为原机，2026-10-22从VPS当前授权文件读取）：

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFmUNIaLdCy4EwrGRcDeYMeZRyx6QuGYnvog+otj7pFA ccdesk-malaysia-relay
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPhR5h9rd3dnORPSADHBYwruPFZVZhzmAJPOn7KrcgwC ubuntu-cc-02-bwg
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGB+BAephidz6Y15JCbZg1fB7XASKOdiktAaC3KMbiVf ubuntu-cc-03-bwg
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMw+LtmxpoqAio1RsRixh5pO6XSe4ckUSkeuOu7cbJNP ubuntu-cc-04-bwg
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINAzy/CyLJIHtwlX0kWtAJJvMH5EPZhemlDYHvaG9Ia4 ubuntu-cc-05-bwg
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL7mN2sroQWd516HGc7RdbpUJokVuB+upURVoOB3snKP ubuntu-cc-06-bwg
```

这些裸公钥用于对照；恢复授权时必须附上各自对应端口的限制，不能直接按无约束公钥批量追加。第一台还保留了返回旧安装脚本的forced command，具体见第5.6节。VPS本次03～06授权备份位于同一`.ssh`目录，文件名形如`authorized_keys.before-ubuntu-cc-03-时间戳`。

### 5.5 VPS SSH主机密钥

经root运维通道核实的ED25519指纹：

```text
SHA256:Q7TmQOsYoY+V4agj8p2bwHx5qICS3gBqt0NIan/38to
```

新增Ubuntu的专用known_hosts内容：

```text
74.82.201.214 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpdsTQ0vC1ya2DfVdhYbSsQ/Tfh+SjSSvyuhYn0XfnF
```

VPS重装后应从可信控制台重新核实主机密钥，再更新各机known_hosts；不要用关闭主机密钥校验处理报错。此SSH指纹不能填进CC客户端证书栏。

### 5.6 第一台ubuntu-cc的独立维护档案

第一台属于六台中的正式维护对象，保留已有账号、会话、证书与数据。其已知参数如下：

| 项目 | 第一台实际/历史记录 |
| --- | --- |
| 实际主机名、用户 | `ubuntu-cc`、`benben` |
| 最近内网IP | `172.28.149.26`，2026-10-22控制台确认；DHCP地址可能变化 |
| CC公网/上游 | `wss://74.82.201.214:8443/ws`、`127.0.0.1:8787` |
| Ubuntu隧道unit | `/etc/systemd/system/cc-bwg-relay.service` |
| Ubuntu隧道私钥 | `/home/benben/.ssh/cc-hk-relay-test`，沿用旧文件名 |
| VPS SSH主机密钥文件 | `/home/benben/.ssh/known_hosts`，与02～06专用文件不同 |
| 本地健康检查证书副本 | `/etc/ccdesk-relay/upstream.crt` |
| VPS unit | `/etc/systemd/system/ccdesk-relay.service`，本次读取确认端口仍为8443→28787，双向nodelay |
| CC运行方式 | Docker，容器`cc-desk-tunnel-ba938975-proxy-1`，镜像`cc-desk-tunnel:local`；2026-10-22检查为healthy |
| CC程序与部署配置 | `/opt/cc-desk-tunnel`、`/opt/cc-desk-tunnel/.local/docker.env` |
| CC持久数据与服务环境 | `/srv/cc-desk-tunnel`挂载至`/data`；服务配置`/srv/cc-desk-tunnel/config/service.env`已确认存在；原生Claude子目录未单独读取 |
| 主机端口绑定 | 本次读取为`0.0.0.0:8787->8787/tcp`，与02～06的回环绑定不同；此次遥测维护不调整端口 |

原安装脚本记录的Ubuntu隧道ExecStart为：

```text
/usr/bin/ssh -NT -i /home/benben/.ssh/cc-hk-relay-test -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/home/benben/.ssh/known_hosts -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 127.0.0.1:28787:127.0.0.1:8787 ccdesk-relay@74.82.201.214
```

该脚本的unit使用`Type=exec`、`User=benben`、`Restart=always`、`RestartSec=5`，并执行enable --now。以上是已保存安装脚本的记录，第一台当前unit以`systemctl cat`读取结果为准，不需要为了统一格式覆盖它。

从VPS当前authorized_keys读取到的第一台授权完整行：

```text
restrict,port-forwarding,permitlisten="127.0.0.1:28787",permitopen="127.0.0.1:28787",command="/bin/cat /usr/local/share/ccdesk-relay/install-ubuntu.sh" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFmUNIaLdCy4EwrGRcDeYMeZRyx6QuGYnvog+otj7pFA ccdesk-malaysia-relay
```

`ssh -N`不申请远程命令，因此该授权可以建立隧道。旧forced command与02～06的`/bin/false`不同，维护时保留其实际行为，不能直接用其他机器的授权行覆盖。

进入第一台后的最小检查：

```bash
hostname
ip -br a
sudo systemctl cat cc-bwg-relay.service
sudo systemctl status cc-bwg-relay.service --no-pager
sudo journalctl -u cc-bwg-relay.service -n 60 --no-pager
sudo ss -lntp '( sport = :8787 )'
command -v docker || true
sudo ls -ld /opt/cc-desk-tunnel /srv/cc-desk-tunnel
sudo ls -l /opt/cc-desk-tunnel/.local/docker.env
sudo openssl x509 -in /etc/ccdesk-relay/upstream.crt -noout -fingerprint -sha256 -dates
```

第一台已通过目录与容器挂载只读检查确认Docker布局，见本节表格；无需重复探查或改成原生部署。未来若路径不存在，先确认主机名与实际布局，不代表第一台损坏；不要为套用模板而重装或重新初始化。

第一台若更新了实际CC证书，还要同步用于健康检查的`/etc/ccdesk-relay/upstream.crt`副本，避免旧副本校验失败；复制前先确认实际证书来源，不能拿其他机器的证书替换。

## 6. 日常检查与故障定位

### 6.1 Ubuntu：本机健康、隧道与证书

以下管理脚本及数据路径适用于当前已确认的六台Docker部署；第一台的隧道文件与端口绑定区别见第5.6节。隧道status/journal命令适用于六台。

```bash
hostname
df -h /
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh status
sudo grep -E '^(CONTROL_BIND|CONTROL_PORT|CONNECTION_URL)=' .local/docker.env
sudo systemctl is-enabled docker cc-bwg-relay.service
sudo systemctl status cc-bwg-relay.service --no-pager
sudo journalctl -u cc-bwg-relay.service -n 60 --no-pager
sudo openssl x509 -in /srv/cc-desk-tunnel/tls/control.crt \
    -noout -fingerprint -sha256 -dates
sudo curl --fail --silent --show-error --noproxy '*' \
    --connect-timeout 5 --max-time 15 \
    --cacert /srv/cc-desk-tunnel/tls/control.crt \
    --resolve cc-desk-tunnel.local:8787:127.0.0.1 \
    https://cc-desk-tunnel.local:8787/health
echo
```

容器日志：`sudo bash deploy/manage.sh logs`，按Ctrl+C退出。分享前移除凭据和业务内容。不要分享完整service.env、provider.json或`manage.sh connection`输出。

### 6.2 Ubuntu：通过VPS检查本机公网入口

下面按当前主机名选择六台各自入口及健康检查证书：

```bash
(
    set -e
    ccCert=/srv/cc-desk-tunnel/tls/control.crt
    case "$(hostname)" in
        ubuntu-cc) ccPort=8443; ccCert=/etc/ccdesk-relay/upstream.crt ;;
        ubuntu-cc-02) ccPort=8444 ;;
        ubuntu-cc-03) ccPort=8445 ;;
        ubuntu-cc-04) ccPort=8446 ;;
        ubuntu-cc-05) ccPort=8447 ;;
        ubuntu-cc-06) ccPort=8448 ;;
        *) echo '当前主机不在六台维护范围内'; exit 1 ;;
    esac
    sudo curl --fail --silent --show-error --noproxy '*' \
        --retry 5 --retry-all-errors --retry-delay 2 \
        --connect-timeout 5 --max-time 15 \
        --cacert "$ccCert" \
        --resolve "cc-desk-tunnel.local:${ccPort}:74.82.201.214" \
        "https://cc-desk-tunnel.local:${ccPort}/health"
    echo
)
```

首次启动03～06隧道时，每台均发生过一次`SSL_ERROR_SYSCALL`，随后重试成功；本机另行核对证书和HTTP 200也通过。可能是隧道刚启动、回环端口尚未就绪；没有追踪到足以确定根因的日志。若启动后持续失败或运行中反复发生，按下表查日志，不能因以前重试成功就忽略。

### 6.3 VPS：只检查目标机器

root终端，以下以03为例：

```bash
systemctl is-active ccdesk-relay-ubuntu-cc-03.service
systemctl is-enabled ccdesk-relay-ubuntu-cc-03.service
systemctl cat ccdesk-relay-ubuntu-cc-03.service
ss -lntp '( sport = :8445 or sport = :28789 )'
journalctl -u ccdesk-relay-ubuntu-cc-03.service -n 60 --no-pager
ufw status
```

其他机器同时替换unit名及两处端口。第一台特别使用`ccdesk-relay.service`及8443/28787，不是`ccdesk-relay-ubuntu-cc-01.service`。`active`只说明进程存活；要同时看到公网端口、回环隧道监听及带证书校验的健康结果。

### 6.4 按现象排错

| 现象 | 下一步 |
| --- | --- |
| 旧172.28地址无法SSH | 在远端Windows查询当前IP与VM状态；再查目标Ubuntu网络，不重建系统 |
| ssh.service inactive | Ubuntu24.04可能由ssh.socket激活；结合监听与实际SSH结果判断 |
| 本机8787健康失败 | 查CC容器状态、日志、磁盘和证书；先修复上游 |
| 本机健康正常，VPS回环端口未监听 | 查Ubuntu隧道journal、公钥授权、私钥权限及网络 |
| Permission denied (publickey) | 核对该机私钥与VPS的ccdesk-relay授权；不要只查看root授权文件 |
| remote port forwarding failed | 查目标回环端口占用，以及permitlisten与-R是否一致 |
| 回环监听正常，公网入口未监听 | 查对应socat unit及日志；不要重启全部入口 |
| VPS端口都在，外部无法访问 | 查UFW、可能存在的云防火墙与客户端网络 |
| SSL_ERROR_SYSCALL持续发生 | 查上述监听、CC本机健康及两端日志；保留失败时间 |
| 证书指纹不符 | 核对是否指向另一台机器或刚续期；通过可信SSH读证书，不跳过验证 |
| /health正常，CC登录失败 | 检查该机PROXY_TOKEN、客户端版本/协议；不使用其他机器的token |
| CC能连接，模型失败 | 查该机原生登录/API配置、模型出口与服务日志 |
| 能聊天，本地命令失败 | 查本地CC执行通道、回环SSH与实际工具输出；公网中转健康不覆盖此项 |
| 哈希变化、zstd/SQUASHFS/解压校验错误 | 保留现场，排查宿主机存储/内存数据路径，勿跳过完整性校验 |

## 7. 本地客户端、模型与执行验收

### 7.1 各台建立独立连接

1. 从项目发布页安装所需Windows客户端，先核对与服务端的兼容性；当前源码工作区可能是旧版本，不要据此覆盖服务端。
2. 六台各使用独立连接：保留第一台当前连接，为02～06新建连接。第一台现有连接正常时无需删除重建。
3. 填第3节地址，证书模式选择指纹，填该机CC证书SHA256。
4. 六台均可在该Ubuntu本人控制的终端执行以下命令读取服务凭据；第一台保留现用token：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh connection
```

只将`PROXY_TOKEN`的值填入客户端，不带变量名和外层引号。不把输出回传聊天或公开存档。按需选择“记住凭据”，凭据由当前Windows用户加密保存。

CC主连接日志通常位于`%APPDATA%\CC Desk Tunnel\logs\client.log`；附加连接可能使用独立profile。日常本地Windows使用Clash时，已有的持久直连规则可保留：

```text
IP-CIDR,74.82.201.214/32,DIRECT,no-resolve
```

先核对实际规则命中与当前网络效果，无需重复追加。

### 7.2 模型认证（目前暂缓）

按实际使用方式为需要使用的连接单独配置，新增五台不通过复制原机账号目录完成认证。

第一台保留现用账号和提供方配置，不因本次维护退出或重新登录。下述`/srv/cc-desk-tunnel`与manage.sh路径已确认适用于六台当前Docker部署。第一台的既有账号不能复制给新增五台作为认证方式。

- Claude账号：在CC“设置 → 账号与额度”按官方登录流程打开授权页、回填授权码、刷新状态。提供方配置默认`{}`即可，不额外填写API key。
- 模型API：编辑`/srv/cc-desk-tunnel/config/provider.json`，使用提供方实际支持的Anthropic兼容接口与凭据。示例仅为格式，不能直接使用：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.example.com",
    "ANTHROPIC_AUTH_TOKEN": "替换为提供方凭据",
    "ANTHROPIC_MODEL": "替换为支持的模型ID"
  }
}
```

提供方若要求`ANTHROPIC_API_KEY`，按其文档配置；不要直接填OpenAI协议接口，也不要把CC的PROXY_TOKEN作为模型key。保留已有配置，避免两套认证相互影响。编辑后在目标Ubuntu执行：

```bash
sudo python3 -m json.tool /srv/cc-desk-tunnel/config/provider.json > /dev/null
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh restart
```

### 7.3 模型默认IPv4出口核对

远端Windows PowerShell：

```powershell
curl.exe -4 --noproxy '*' --silent --show-error --max-time 15 https://api.ipify.org
```

目标Ubuntu及CC容器：

```bash
curl -4 --noproxy '*' --silent --show-error --max-time 15 https://api.ipify.org
echo
cd /opt/cc-desk-tunnel
ccProject="$(sudo sed -n "s/^PROJECT_NAME='\(.*\)'$/\1/p" .local/docker.env)"
sudo docker compose --env-file .local/docker.env -p "$ccProject" \
    -f deploy/docker/compose.yaml exec -T proxy \
    curl -4 --noproxy '*' --silent --show-error --max-time 15 https://api.ipify.org
echo
```

这比较默认IPv4出口；`--noproxy '*'`不绕过系统TUN/VPN，也不证明单独配置代理的Claude请求出口。只有实际需要Windows HTTP代理时，才配置容器可访问的Windows内网地址与真实端口，不能把容器的`127.0.0.1`当作Windows。记录实际代理/路由后再判断模型出口是否满足原要求。

### 7.4 实际模型与Windows执行

在本地CC选择本地项目目录，新建会话，先发普通问题确认模型回复，再发送：

```text
请通过本机执行通道，在我的 Windows 上执行 hostname 和 Get-Location，返回结果，不修改文件。
```

核对真实工具调用与输出：应为日常本地Windows机器名和选定项目目录，而不是远端Windows、Ubuntu或容器。模型口头声称成功不算执行验收。

## 8. 启停、续期与凭据轮换

操作前确认主机名、当前无项目任务且连接空闲。以下CC管理脚本适用于已确认的六台Docker部署；重启CC会使客户端短暂断开，并可能中断正在执行的Claude任务。所有操作只针对当前目标Ubuntu：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh status
# 按需要择一执行，不是要求连续执行全部命令：
sudo bash deploy/manage.sh restart
sudo bash deploy/manage.sh stop
sudo bash deploy/manage.sh up
```

六台隧道排错后如需重启，均使用`sudo systemctl restart cc-bwg-relay.service`。VPS只重启目标unit：第一台为`systemctl restart ccdesk-relay.service`，03示例为`systemctl restart ccdesk-relay-ubuntu-cc-03.service`；会短暂断开该入口，不连带重启其他机器。修改unit后先`systemd-analyze verify /etc/systemd/system/目标.service`，再`systemctl daemon-reload`和重启该unit。

Docker Compose使用`restart: unless-stopped`。手工停止的容器不应假定重启宿主机就恢复；计划恢复时执行`manage.sh up`。容器仅显示unhealthy不会自动触发Docker重启，应查原因。

### 8.1 自签证书续期

先查看证书日期（第6节），在维护窗口备份后执行：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh renew
sudo openssl x509 -in /srv/cc-desk-tunnel/tls/control.crt \
    -noout -fingerprint -sha256 -dates
```

会更换证书并按原运行状态重启服务；将新指纹填入所有连接该机的客户端及本手册，然后重新验收本机和公网健康。VPS透明转发无需更换TLS证书。

### 8.2 更换CC服务凭据

在该Ubuntu本人控制的终端执行：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh token
```

此命令生成新token并显示私密连接汇总，旧token失效，所有使用该机的客户端需更新。不要回传输出。它不会替换SSH隧道私钥或模型凭据。

### 8.3 Claude对外遥测、自动更新与订阅额度策略

2026-10-22用户最终目标为：关闭Claude Code官方遥测、错误上报和自动更新，同时保留订阅额度查询及CC本机OpenTelemetry接收的token、费用与耗时统计。第一台已通过额度恢复验证，最终目标配置为：

```text
DISABLE_TELEMETRY=1
DISABLE_ERROR_REPORTING=1
DISABLE_AUTOUPDATER=1
```

长期默认要求：现有六台及后续每台新建、重建或迁移后部署Claude Code的Ubuntu，都采用以上三个独立开关，并移除`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`。这取代此前的总开关默认方案，避免订阅额度查询被阻断。保留CC本机OpenTelemetry统计；首次启动前持久配置，启动、升级或恢复后复核，不只在SSH会话中export。相同Docker布局按第12.2节执行；其他运行方式应写入其实际Claude启动环境。

三个开关均为官方公开配置。CC服务源码仍为Claude进程注入`CLAUDE_CODE_ENABLE_TELEMETRY=1`、`OTEL_LOGS_EXPORTER=otlp`及本机`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`等配置；这些本机统计参数保持不动，不删除、不清空、不改为none。

`DISABLE_TELEMETRY`也会禁用功能开关获取，可能影响Remote Control等依赖功能，见[官方环境变量说明](https://code.claude.com/docs/en/env-vars)。此次使用官方配置，不修改CLI、不伪装身份、不绕过账号/并发限制；官方未保证任何设置绝不会触发账号风控，不能以关闭遥测作为规避风控的方法。

不再使用总开关：它会阻止CLI单独获取订阅额度的请求，已在第一台出现原生`/usage`加载失败及CC额度窗口为空；移除总开关并改为三个独立开关后，用户确认CC显示恢复，见第8.3.4节。独立开关只控制所列项目，其他辅助功能恢复各自默认行为，不能声称精确地只放行了额度接口。CC本机OpenTelemetry配置保留，新统计实际增长另行验证。

六台此前均将总开关持久写入`/srv/cc-desk-tunnel/config/service.env`，现均已移除总开关、改为三个独立开关，由CC启动时的Node `--env-file`读取并继承给Claude；不只在SSH窗口export。修改前复制私密备份，保留原文件属主与权限，仅调整这些开关，不改token、提供方或现有OpenTelemetry参数。最终配置见第8.3.5节，逐台验收结果见下表。

第一台已确认Docker运行方式及同样的服务配置路径，并已完成配置备份、移除总开关、设置三个独立开关、重启CC与公网健康核对。该机有实际账号和使用记录，此次没有执行初始化、升级或重新登录。后续维护仍需等待进行中的Claude任务结束再重启CC。CLI自动更新关闭不阻止管理员有意执行CC升级/镜像重建时安装选定版本。

| 机器 | 持久修改与重启 | 配置/健康核对 | 实际模型调用后本机统计增长 |
| --- | --- | --- | --- |
| 01：ubuntu-cc | 已备份并切换为三个独立开关、重启（2026-10-22）；总开关已移除 | 总开关unset，三个独立开关均为1；公网证书/健康通过；CC额度已恢复：5小时0%、每周7% | 历史统计保留；新统计增长待核对 |
| 02 | 已备份并切换为三个独立开关、重启（2026-10-22）；总开关已移除 | 总开关unset，三个独立开关均为1；切换后公网证书指纹匹配、HTTP 200且健康正常；账号/额度未单独验收 | 待核对 |
| 03 | 已备份并切换为三个独立开关、重启（2026-10-22）；总开关已移除 | 总开关unset，三个独立开关均为1；切换后公网证书指纹匹配、HTTP 200且健康正常；账号/额度未单独验收 | 待核对 |
| 04 | 已备份并切换为三个独立开关、重启（2026-10-22）；总开关已移除 | 总开关unset，三个独立开关均为1；切换后公网证书指纹匹配、HTTP 200且健康正常；账号/额度未单独验收 | 待核对 |
| 05 | 已备份并切换为三个独立开关、重启（2026-10-22）；总开关已移除 | 总开关unset，三个独立开关均为1；切换后公网证书指纹匹配、HTTP 200且健康正常；账号/额度未单独验收 | 待核对 |
| 06 | 已备份并切换为三个独立开关、重启（2026-10-22）；总开关已移除 | 总开关unset，三个独立开关均为1；切换后公网证书指纹匹配、HTTP 200且健康正常；账号/额度未单独验收 | 待核对 |

六台现均完成最终独立开关方案切换，配置读取及切换后公网证书/健康均通过，逐台结果见上表。第一台切换后已恢复CC订阅额度。原重启终端动画停在Restarting不等于服务失败，第一台随后配置读取与公网健康均正常。维护脚本已同步独立开关方案。历史统计保留不等于新统计增长已验证；新增机器模型测试仍按原安排暂缓，正常使用后再核对本机token、费用和耗时统计增长。

#### 8.3.1 后续配置与只读核对

六台现均已完成，无需重复修改。以下步骤供后续配置恢复及维护参考；先确认目标主机及无进行中的Claude任务、关闭CC原生终端。新节点必须另行确认路径，不能直接套用当前六台的主机名范围。

```bash
(
set -e
case "$(hostname)" in
    ubuntu-cc|ubuntu-cc-0[2-6]) ;;
    *) echo '当前主机不在六台维护范围内'; exit 1 ;;
esac
cd /opt/cc-desk-tunnel
ccEnv=/srv/cc-desk-tunnel/config/service.env
sudo cp -p "$ccEnv" \
    "$ccEnv.before-selective-$(date -u +%Y%m%dT%H%M%SZ)"
sudo sed -i \
    '/^\(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\|DISABLE_TELEMETRY\|DISABLE_ERROR_REPORTING\|DISABLE_AUTOUPDATER\)=/d' \
    "$ccEnv"
printf "\nDISABLE_TELEMETRY='1'\nDISABLE_ERROR_REPORTING='1'\nDISABLE_AUTOUPDATER='1'\n" |
    sudo tee -a "$ccEnv" >/dev/null
sudo bash deploy/manage.sh restart
)
```

需要只读核对时，执行下段；它不调用模型，也不重启服务：

```bash
(
set -e
cd /opt/cc-desk-tunnel
ccProject="$(sudo sed -n "s/^PROJECT_NAME='\(.*\)'$/\1/p" .local/docker.env)"
sudo docker compose --env-file .local/docker.env \
    -p "$ccProject" -f deploy/docker/compose.yaml \
    exec -T proxy \
    node --env-file=/data/config/service.env -e \
    'for (const key of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC","DISABLE_TELEMETRY","DISABLE_ERROR_REPORTING","DISABLE_AUTOUPDATER"]) console.log(key+"="+(process.env[key] ?? "unset"))'
)
```

预期总开关为`unset`，其余三个开关均为`1`。这是容器内Node按指定env-file解析的结果，不是对实际模型请求内容的检查。CC给Claude子进程注入本机OpenTelemetry参数，服务父进程环境中没有这些子进程参数不代表统计失效；不能仅用`docker exec env`或`/proc/PID/environ`判断Node启动后加载的所有配置。健康检查按第6节进行；已登录账号可在CC刷新额度，正常使用后核对新增token、费用与耗时记录，不为验证而自动发起付费模型请求，不为新增机器复制账号凭据。

#### 8.3.2 取消禁用策略或回退配置

正常维护不执行此段。只有用户以后明确要求恢复官方遥测、错误上报和自动更新的默认行为时，才移除这些开关并重启CC。总开关、`DISABLE_TELEMETRY`和`DISABLE_ERROR_REPORTING`按非空值判断，写成0或false不能取消禁用，需删除变量。先确认任务空闲，执行：

```bash
(
set -e
case "$(hostname)" in
    ubuntu-cc|ubuntu-cc-0[2-6]) ;;
    *) echo '当前主机不在六台维护范围内'; exit 1 ;;
esac
cd /opt/cc-desk-tunnel
ccEnv=/srv/cc-desk-tunnel/config/service.env
sudo cp -p "$ccEnv" \
    "$ccEnv.before-enable-telemetry-$(date -u +%Y%m%dT%H%M%SZ)"
sudo sed -i \
    '/^\(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\|DISABLE_TELEMETRY\|DISABLE_ERROR_REPORTING\|DISABLE_AUTOUPDATER\)=/d' \
    "$ccEnv"
sudo bash deploy/manage.sh restart
)
```

再运行上节只读核对，四个变量应均为`unset`；若仍有值，检查实际启动环境，仅检查相关键，不回传完整配置。历史环境文件备份与原文件位于同一目录，前缀有`service.env.before-selective-`或较早的`service.env.before-nonessential-`。恢复旧备份前核对其中开关及此后是否变更token、提供方等设置，避免重新启用总开关或覆盖较新凭据。配置备份不等同于第9节的完整数据备份。

#### 8.3.3 仓库隐私与验证边界

无论此前总开关还是当前独立开关方案，都不等同于禁止模型请求、身份认证、计费或服务运行所需的数据传输，也不能据此保证Git仓库地址或全部项目身份信息绝不会随请求外发。六台的开关解析与健康验收没有检查实际模型请求正文。截图/第三方分析所述`x-claude-code-wiggly-dove`、`tengu_wiggly_dove`及其字段、灰度范围和开关适用性，尚无本次可核实的官方说明或六台实测证据，不能作为已验证事实，也不能承诺这些开关覆盖它。

[官方数据使用说明](https://code.claude.com/docs/en/data-usage)与[官方本机监控说明](https://code.claude.com/docs/en/monitoring-usage#repository-attributes)应分别阅读。后者的`OTEL_METRICS_INCLUDE_REPOSITORY`是默认关闭、向自选采集端导出仓库属性的功能，不是上述截图指控的同一机制；本次没有新增或修改该参数。

禁止访问`.git`会影响Git状态、差异、历史、分支及提交等操作；同一系统用户的文件权限不能单独区分Claude和用户本人，也不能排除仓库地址已存在于缓存、配置、命令输出或上下文中。若实际项目位于Windows，只修改Ubuntu的`.git`权限也不等于限制Windows执行通道。此次没有设置`.git`权限限制、修改CLI、伪造身份或篡改请求。严格禁止外发的项目身份/代码不能以该总开关或目录权限作为保密保证，应先确认允许使用云端模型的范围。

#### 8.3.4 订阅额度查询与总开关的兼容限制

2026-10-22第一台在总开关方案下：CC账号页提示“原生接口未返回额度窗口”，点击刷新后仍然如此；同一账号官方网页显示当前周期0%、本周7%；原生`/usage`也显示`Error: Failed to load usage data`。用户随后按官方独立开关方案移除总开关、保留三个DISABLE开关并重启，确认CC额度恢复：5小时0%、每周7%。因此本次有配置切换前后的实际显示对照；没有为验证主动发送模型请求，也没有修改CLI或账号。

公开依据：[Claude Code仓库issue #71886](https://github.com/anthropics/claude-code/issues/71886)报告了相同总开关下`/usage`相同报错；[仓库协作者说明](https://github.com/anthropics/claude-code/issues/71886#issuecomment-5310205759)确认，独立的订阅额度查询属于被总开关抑制的非推理请求，请求会在发出前被阻止，报错文案没有解释配置原因。该说明还指出，模型响应有时会携带部分额度信息，因此正常使用后有时能看到窗口；不能保证完整数据或为验证而专门发送模型请求。这是公开问题及协作者解释，不等同于本次已经逐项审计当前安装二进制或所有版本行为。

最终处理策略：现有及以后新Ubuntu采用三个独立开关并移除总开关，按第8.3.1节部署。第一台CC订阅窗口已恢复，其余机器的切换进度见第8.3节表格；[官方网页用量](https://claude.ai/settings/usage)可作为对照。不退出登录、不复制凭据、不篡改CLI或请求，也不直接提取OAuth凭据调用额度接口。

订阅额度与CC本机OpenTelemetry累计的token、等价API费用、耗时不是同一数据源；本机统计不能反推整个账号的5小时/周额度。此次仍保留本机统计配置，实际增长待正常使用后验证。截图的`Claude Code can't auto-update`也不作为要求恢复自动更新的依据，用户已明确禁用自动更新。

#### 8.3.5 独立开关方案推广进度

2026-10-22用户进一步要求评估“关闭遥测和自动更新，同时放开额度查询”。[官方环境变量文档](https://code.claude.com/docs/en/env-vars)和[官方数据使用说明](https://code.claude.com/docs/en/data-usage)支持分别设置：

```text
DISABLE_TELEMETRY=1
DISABLE_ERROR_REPORTING=1
DISABLE_AUTOUPDATER=1
```

该方案必须移除`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`，不能将其写成0或false，也不能同时保留总开关后期待独立开关放行额度。三个独立开关分别关闭官方遥测、错误上报和CLI后台自动更新；不再用总开关统一阻断非必要请求，因此适合验证原生订阅额度查询是否恢复。没有核实到“保持总开关且仅豁免额度查询”的官方配置。移除总开关也会使未被独立开关控制的其他辅助功能恢复各自默认行为，不能称为只放行了一个接口；`DISABLE_TELEMETRY`仍会禁用功能开关获取。

CC现有`CLAUDE_CODE_ENABLE_TELEMETRY=1`及本机`OTEL_*`参数继续保留，不改账号、提供方或CLI，不提取OAuth凭据直连额度接口。先关闭第一台CC原生终端并等待任务结束，在SSH终端备份service.env，清理四个旧键后仅写入三个独立开关，重启CC并检查新进程读取值；再用官方`/usage`和CC账号页刷新验证额度。正常使用后另行核对本机统计增长。

执行状态：第一台总开关unset，三个独立开关均为1，公网证书匹配、HTTP 200、协议19；用户随后提供CC截图确认5小时0%、每周7%，历史每周127次请求、2114.4万tokens、等价$11.11仍保留。这些是截图时点的历史累计值，不证明切换后新统计增长；未另收到切换后原生`/usage`截图，不将其单列为已验证。其余机器按第8.3节表格记录切换进度。首次部署默认步骤已同步独立开关，不能重新叠加总开关。

## 9. 备份与恢复

### 9.1 需要备份的内容

| 范围 | 内容 |
| --- | --- |
| 各Ubuntu CC完整持久数据 | 账号、原生上下文、GUI索引、模型配置、CC服务凭据、TLS证书/私钥 |
| 各Ubuntu部署与隧道 | 程序版本、`.local/docker.env`、unit、隧道私钥/公钥、known_hosts |
| VPS | 各机转发unit、授权文件、相关防火墙记录及本手册；root运维密钥由持有人另行保管 |
| 日常本地Windows | 实际项目文件；如需客户端偏好，按该用户的应用数据另行备份 |

CC备份不包含日常Windows项目，也不自动包含Ubuntu数据目录以外的SSH隧道文件。Hyper-V检查点不代替独立备份；已知数据完整性问题下，更应把副本放在不同物理设备。

### 9.2 单台Ubuntu一致性备份

以下适用于已确认采用本手册Docker布局的六台机器，备份会短暂停CC，结束后恢复此前运行状态。先等待Claude任务结束。脚本按主机名区分第一台和02～06的隧道文件；不能用新增机器的隧道文件替代第一台：

```bash
(
    set -e
    case "$(hostname)" in
        ubuntu-cc)
            ccTunnelFiles=(
                home/benben/.ssh/cc-hk-relay-test
                home/benben/.ssh/known_hosts
                etc/ccdesk-relay
            )
            ;;
        ubuntu-cc-0[2-6])
            ccTunnelFiles=(
                home/benben/.ssh/cc-bwg-relay
                home/benben/.ssh/cc-bwg-relay.pub
                home/benben/.ssh/cc-bwg-known-hosts
            )
            ;;
        *) echo '当前主机不在六台维护范围内'; exit 1 ;;
    esac
    cd /opt/cc-desk-tunnel
    ccBackupDir="/var/backups/cc-desk-tunnel/$(hostname)-$(date -u +%Y%m%dT%H%M%SZ)"
    sudo install -d -m 700 "$ccBackupDir"
    sudo bash deploy/manage.sh backup "$ccBackupDir/data.tar.gz"
    sudo tar -czf "$ccBackupDir/deployment-and-tunnel.tar.gz" -C / \
        opt/cc-desk-tunnel \
        etc/systemd/system/cc-bwg-relay.service \
        "${ccTunnelFiles[@]}"
    sudo chmod 600 "$ccBackupDir/deployment-and-tunnel.tar.gz"
    sudo sha256sum "$ccBackupDir/data.tar.gz" \
        "$ccBackupDir/deployment-and-tunnel.tar.gz" |
        sudo tee "$ccBackupDir/SHA256SUMS" >/dev/null
    echo "备份目录：$ccBackupDir"
)
```

第一台当前已确认Docker部署，适用以上备份步骤。六台本次只收到遥测修改前的环境文件备份回执，尚未收到完整数据与隧道独立备份回执，不将配置备份记为完整备份完成。

备份包含私密数据，只传到自己控制的存储；转移后复核哈希，并在空白环境验证恢复。哈希一致证明传输字节一致，不等同于全部业务数据可用。只有留在同一宿主机C盘的副本不算独立备份。

### 9.3 VPS配置备份

VPS root终端：

```bash
(
    set -e
    ccBackupDir="/root/ccdesk-relay-backups/$(date -u +%Y%m%dT%H%M%SZ)"
    install -d -m 700 "$ccBackupDir"
    tar -czf "$ccBackupDir/relay-config.tar.gz" -C / \
        etc/systemd/system/ccdesk-relay.service \
        etc/systemd/system/ccdesk-relay-ubuntu-cc-0{2,3,4,5,6}.service \
        var/lib/ccdesk-relay/.ssh/authorized_keys \
        usr/local/share/ccdesk-relay/install-ubuntu.sh
    chmod 600 "$ccBackupDir/relay-config.tar.gz"
    ufw status numbered > "$ccBackupDir/ufw-status.txt"
    sha256sum "$ccBackupDir/relay-config.tar.gz" > "$ccBackupDir/SHA256SUMS"
    echo "备份目录：$ccBackupDir"
)
```

此备份覆盖六个转发unit、六台授权及第一台forced command引用的旧安装脚本。防火墙文本是规则记录，不是可直接导入脚本。VPS重装时还需重建专用用户、socat及SSH服务条件，不能仅解压unit就认为恢复完成。SSH主机密钥变化时按第5.5节重新核实。

### 9.4 恢复或搬迁单台CC

以下Docker恢复步骤适用于当前六台已确认的部署。恢复前必须有目标机器对应的可信完整备份，不能把单个service.env配置备份当作完整数据备份。

1. 保留旧机与备份，确认目标主机、数据目录和对应端口。不要把一台现用机器的数据覆盖成另一台的身份。
2. 在目标安装兼容的程序及Docker，执行一次`init`创建新的空部署；**此分支先不执行setup/build/up启动服务**。
3. 将可信的`data.tar.gz`传到目标，核对哈希。恢复只接受已停服且`state/home/workspace`为空的初始化部署。
4. 在目标程序目录执行：

```bash
sudo bash deploy/manage.sh restore /安全路径/data.tar.gz
```

5. 核对部署配置中的`CONTROL_BIND`、`CONTROL_PORT`、`CONNECTION_URL`，以及恢复的数据配置和证书；按需`build`、`up`。恢复数据不自动恢复程序目录外的SSH隧道文件。
6. 处理隧道：迁移同一机器身份时可从私密备份恢复原隧道文件及权限，但旧隧道必须先停止，不能同时争用同一回环端口；作为独立新增机器时生成新密钥并分配新端口，不能复制旧机身份。
7. 重新做本机、公网、证书、客户端、模型与执行验收。沿用完整恢复的证书/token时可保持客户端值；证书替换后更新指纹。

已有业务数据的目标不满足空恢复条件时，使用独立新部署目录或另建目标，不为强行恢复删除现有目录。GUI记录只是展示索引，长期上下文还依赖Claude原生数据，不能只备份SQLite或Windows聊天缓存。

## 10. 升级与回退

六台均纳入升级维护，一次只升级一台，先确认客户端兼容性、查阅发布说明并完成第9节备份。下述命令适用于已确认的六台Docker布局。保留旧程序归档和旧Docker镜像；不要先清理它们。

1. 查询当前部署版本：`sudo sed -n '1,12p' /opt/cc-desk-tunnel/apps/desktop/package.json`；协议以当前健康结果为准。
2. 在目标Ubuntu从官方发布页下载选定服务端归档及同一版本SHA256SUMS，验证归档哈希后继续。
3. 进入程序目录执行（替换实际归档路径）：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh upgrade --from /实际路径/cc-desk-tunnel-server-X.Y.Z.tar.gz
```

4. 升级会重建镜像、替换容器，且可能显示含token的连接汇总，输出仅本人查看。完成后按第6、7节验收并更新版本与日期。

`manage.sh upgrade`不带`--from`主要重建当前程序，不应当作自动获取最新版。首次安装器检测到现有部署也有升级流程，但不要为了升级重跑`init`。

回退需恢复兼容的旧程序与镜像；必要时在新空部署恢复升级前的数据备份。仅切回旧镜像不保证升级后的数据格式兼容。保留原环境，先验证再切换。单台回退不应停止其他公网入口。

## 11. 开机恢复与重启验收

本次没有对六台进行重启验收；02～06已执行开机启动配置，第一台安装脚本有enable记录，当前CC与虚拟机自动启动策略仍应读取确认。**不能把已有配置或历史使用等同于本次实际重启恢复通过。** 先备份、确认无运行任务，一台通过后再做下一台。

1. 在目标Ubuntu记录主机名、当前IP、本机与公网健康结果，核对Docker及隧道开机启动状态；第一台的隧道区别见第5.6节。
2. 在该Ubuntu执行`sudo reboot`，SSH断开属于预期。
3. 在远端Windows查询VM及当前IP，重新SSH登录；检查容器运行、Ubuntu隧道、本机和公网健康，再检查客户端连接。
4. 若容器此前手工stop，使用`manage.sh up`，不要误判Docker自动恢复失败。
5. Ubuntu逐台通过后，另选维护窗口测试远端Windows宿主机重启。先查看第2.2节的Hyper-V自动启动/停止策略，结合业务决定是否调整；本次没有修改或验收这些策略。
6. 宿主机重启后逐台记录VM启动、当前IP、CC、隧道、公网健康和客户端结果。断电测试仅在具备备份和恢复条件时单独安排。

验收记录可填：

| Ubuntu | 客户端连接 | 模型回复/Windows执行 | 实际模型出口 | Ubuntu重启恢复 | 宿主机重启恢复 |
| --- | --- | --- | --- | --- | --- |
| 01：ubuntu-cc | 历史已使用，本次未复测 | 保留现用环境，本次未复测 | 历史要求Windows出口，现值未复核 | 本次未测试 | 本次未测试 |
| 02 | 未验收 | 暂缓 | 未核对 | 未测试 | 未测试 |
| 03 | 未验收 | 暂缓 | 未核对 | 未测试 | 未测试 |
| 04 | 未验收 | 暂缓 | 未核对 | 未测试 | 未测试 |
| 05 | 未验收 | 暂缓 | 未核对 | 未测试 | 未测试 |
| 06 | 未验收 | 暂缓 | 未核对 | 未测试 | 未测试 |

## 12. 首次部署与新增节点参考

此节供未来新空机器或已确认的空白重建目标使用。**现有六台均已部署，不再执行初始化。** 当前机器若故障，优先按第6节诊断与第9节恢复。第一台已有账号与会话，尤其不能用首次安装覆盖。

所有后续新Ubuntu部署Claude Code时，默认必须执行第8.3节最终策略：持久设置`DISABLE_TELEMETRY=1`、`DISABLE_ERROR_REPORTING=1`、`DISABLE_AUTOUPDATER=1`，移除总开关，保留订阅额度查询和CC本机OpenTelemetry配置。以下首次安装示例已包含此步骤，不能省略。

### 12.1 安装前判断

在目标Ubuntu确认`hostname`、`ip -br a`、`df -h /`、`dpkg --audit`、Docker状态，以及以下路径是否存在：

```bash
sudo ls -ld /opt/cc-desk-tunnel /srv/cc-desk-tunnel
sudo ls -l /opt/cc-desk-tunnel/.local/docker.env
```

已有docker.env不重跑init；只有数据没有配置时保留现场，确定中断位置。不存在的目录报错只是状态证据。

### 12.2 空白Ubuntu首次安装步骤

先选定主机名及第3节对应端口。下例是03的原部署步骤参考；仅在确认该目标确为新的空部署时使用，其他节点需先替换主机和入口参数：

```bash
(
set -e
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 curl openssl ca-certificates
sudo systemctl enable --now docker
curl -fL --connect-timeout 20 --max-time 120 \
    https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh \
    -o /tmp/cc-desk-tunnel-install.sh
sudo bash /tmp/cc-desk-tunnel-install.sh init \
    --host 74.82.201.214 --mode fingerprint --control-port 8787 \
    --data /srv/cc-desk-tunnel --url wss://74.82.201.214:8445/ws
cd /opt/cc-desk-tunnel
sudo sed -i "s/^CONTROL_BIND=.*/CONTROL_BIND='127.0.0.1'/" .local/docker.env
ccEnv=/srv/cc-desk-tunnel/config/service.env
sudo cp -p "$ccEnv" \
    "$ccEnv.before-nonessential-$(date -u +%Y%m%dT%H%M%SZ)"
sudo sed -i \
    '/^\(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\|DISABLE_TELEMETRY\|DISABLE_ERROR_REPORTING\|DISABLE_AUTOUPDATER\)=/d' \
    "$ccEnv"
printf "\nDISABLE_TELEMETRY='1'\nDISABLE_ERROR_REPORTING='1'\nDISABLE_AUTOUPDATER='1'\n" |
    sudo tee -a "$ccEnv" >/dev/null
sudo bash deploy/manage.sh build
sudo bash deploy/manage.sh up
)
```

三个独立开关在首次启动前写入，未改动本机OpenTelemetry参数。启动后按第8.3.1节核对总开关为unset、三个独立开关均为1，再进行账号登录与客户端/模型验收。若未来安装包改变配置路径或加载方式，先确认真实启动环境，不能仅因文件存在就认定Claude已继承这些变量。

安装器会下载执行时的最新发布归档并校验SHA256。未来复现需先确认发布版本与客户端兼容，保留所选版本归档及校验清单；网络安装不保证与2026-10-22相同。此流程不要求apt upgrade或发行版升级。遇到校验、zstd或解压错误先停下定位。

### 12.3 独立密钥、VPS入口与隧道

目标Ubuntu用benben用户生成自己的密钥（已有密钥不得覆盖）：

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
test -f ~/.ssh/cc-bwg-relay || \
    ssh-keygen -t ed25519 -N '' -f ~/.ssh/cc-bwg-relay -C "$(hostname)-bwg"
cat ~/.ssh/cc-bwg-relay.pub
```

然后按顺序：

1. VPS检查目标公网/回环端口和unit未被占用。备份authorized_keys，按第5.4节格式追加该机受限公钥。
2. 按第5.3节创建该机独立转发unit，核对全部端口。运行`sshd -t`、`systemd-analyze verify`，再daemon-reload、UFW放行对应公网TCP端口、enable --now该unit。
3. Ubuntu按第5.5节核实VPS主机密钥并写专用known_hosts（600），按第5.2节写该机隧道unit。运行systemd-analyze verify、daemon-reload、enable --now。
4. 按第6节验证本机与公网健康，并从独立客户端核对该机CC证书指纹；再完成第7、11节验收。
5. 将新节点主机名、端口、IP、公钥、指纹、版本、日期、备份与验收结果写入本手册。未来第七台节点需另选未占用端口，不能复用本表任一现用端口。

PowerShell向VPS Bash传多行脚本需处理CRLF，例如Unix换行文件上传后执行，或使用`tr -d '\015' | bash -s`作为入口；检查最终退出码及实际监听，不能只看部分成功输出。原机旧安装脚本`/usr/local/share/ccdesk-relay/install-ubuntu.sh`固定旧参数，不用于新节点。

## 13. 宿主机、安装介质与硬件异常记录

### 13.1 已安装环境

远端Windows为TOPC TS-FL1C，AMD Ryzen7 7745HX，历史可见内存约31.2GB，C盘初始剩余约836.7GB。新增五台创建时均为Gen2、2vCPU、固定2GB RAM、约30GB动态VHDX；当前资源分配未重新读取，原机可能另有调整，不能套用新增机器数值。

VHDX路径形如`C:\HyperV\CC-Vms\ubuntu-cc-02\ubuntu-cc-02.vhdx`，网络使用Default Switch。安装时各机根分区约29GB、空闲约23GB，这是安装前后历史值，不是部署完成后的实时剩余容量。

### 13.2 ISO与RAM盘

实际安装成功使用RAM盘`R:\ubuntu24.iso`，OSFMount创建，初始5GB。ISO为：

```text
https://releases.ubuntu.com/24.04.3/ubuntu-24.04.3-live-server-amd64.iso
字节数：3303444480
SHA256：C3514BF0056180D09376462A7A1B4F213C1D6E8EA67FAE5C25099C6FD3D8274B
```

RAM下载副本当时连续三次哈希通过。新增五台已安装，不需重新下载ISO；第一台是此前已存在的系统，不把该ISO安装历史套到第一台。02曾在线安装，03～06采用断网离线安装后接回Default Switch。离线内核曾为6.8.0-71-generic，02曾为6.8.0-147-generic，仅作历史记录。

RAM盘是否仍挂载、光驱是否仍引用ISO，本次未重新检查。清理前在远端Windows执行：

```powershell
$ccVmNames = @('ubuntu-cc') + @(2..6 | ForEach-Object { 'ubuntu-cc-{0:D2}' -f $_ })
$ccVmNames | ForEach-Object {
    $ccVmName = $_
    Get-VMDvdDrive -VMName $ccVmName | Select-Object VMName,Path
}
```

此检查覆盖六台，包括第一台可能残留的光驱引用。确认各台从自己的系统盘运行、无安装器后，再卸载ISO引用，并通过OSFMount卸载R盘释放内存。RAM盘断电即丢，不作为备份。本次未执行ISO删除、RAM盘卸载或旧文件清理。

未来重装时正确顺序：Installation complete → 保持ISO挂载点Reboot Now → 等待“移除安装介质并按Enter” → Windows卸载该机ISO → 回VM按Enter。此前过早拔掉live ISO曾导致持续SQUASHFS读取错误。

仅在网卡已经接回Default Switch且Ubuntu eth0仍DOWN/无地址时，才按实际网络配置修复DHCP；本次03～06已经完成以下设置，无需例行重复：

```bash
sudo netplan set ethernets.eth0.dhcp4=true
sudo netplan apply
ip -br a
```

启动时networkd-wait-online曾等待约两分钟；不能只因启动慢就判断磁盘坏或重装。

### 13.3 数据完整性异常：仍未解决

- C盘ISO连续读取的SHA256曾多次变化，Windows Get-FileHash、certutil及Ubuntu读取都出现过不一致。
- Windows曾在约两分钟内有20多次disk事件153（I/O重试）。
- SSD为HS-SSD-C160 1024G、SATA；历史温度50°C、通电4251小时，最大读延迟29648ms、写延迟28099ms。
- chkdsk C: /scan未发现NTFS结构异常，Healthy/OK与部分计数为0仍不能排除间歇故障。
- 64MB内存SHA小测试连续十次通过，不足以排除内存、CPU或其他数据路径问题。
- 03历史在线安装时libc6-dev压缩包解压出现`zstd error: Restored data doesn't match checksum`，随后linux-generic安装失败。不能只归因于网络慢。
- 某次失败前15分钟无新disk153、dmesg尾部无明显I/O/OOM，不推翻此前证据；完整SMART和系统硬件排查尚未完成。
- SATA AHCI驱动显示2006年日期，本身不能证明驱动过旧。

RAM ISO绕过部分已观察到的问题，本次Docker/CC安装成功也不能证明硬件可靠性恢复。若再次校验变化，保留文件、时间、命令、两端哈希及宿主机事件日志，检查存储、连接、内存等数据路径，不跳过完整性校验。

### 13.4 未采用的云镜像路线与残留

原机曾安装qemu-utils、cloud-image-utils和genisoimage，源目录为`/home/benben/cc-vm-images/noble-20261017`；包含ubuntu24-cloud.img、ubuntu24-base.vhdx、seeds/*-seed.iso、SHA256SUMS-transfer。远端Windows接收目录为`C:\HyperV\CC-Cloud`。

原始下载当时校验通过，转换曾比较identical，但大VHDX后续重复读取哈希又变化，Windows副本也与清单不符，因此弃用。**这些磁盘未用于当前新增五台VM，不可当作可靠基础镜像。** seed可能包含密码哈希，不公开分享。

历史创建脚本位于`C:\Users\benben\Desktop\桌面文件夹集合\cc-desk-tunnel\experiments\hyperv-five-ubuntu\`，包括Create-FiveUbuntuVMs.ps1和create-cloud-seeds.sh。新增五台已存在，不重复执行创建脚本；残留文件尚未清理。

## 14. 后续交接与记录更新

可以把以下内容连同本手册交给后续协助者：

> 请以本文维护六台Ubuntu：第一台实际主机名ubuntu-cc，另五台ubuntu-cc-02～06。第一台为原有使用环境，8443/28787、ccdesk-relay.service、旧隧道密钥和known_hosts有独立档案；已确认Docker运行、程序位于/opt/cc-desk-tunnel、/srv/cc-desk-tunnel挂载至/data，主机绑定0.0.0.0:8787，具体见第5.6节。六台均已部署，2026-10-22均已移除CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC，设置DISABLE_TELEMETRY=1、DISABLE_ERROR_REPORTING=1、DISABLE_AUTOUPDATER=1，备份、重启与配置读取通过；切换后逐台核对公网健康与证书，均正常且协议19。第一台CC订阅额度已恢复；CC本机OpenTelemetry配置保留，实际统计增长待验证。后续新机也采用三个独立开关，不再叠加总开关。不要重建虚拟机、重装系统或重复init；各台保持独立数据、证书、token与隧道密钥。当前待做独立备份、02～06客户端连接、按需模型/Windows执行与出口核对、六台逐台重启验收。第一台已有客户端使用记录，不标成从未使用。新增机器模型测试此前暂缓。用户在远端Windows SSH终端执行Ubuntu命令；99794电脑可用已有SSH密钥管理VPS。存储完整性根因未解，遇校验/解压错误保留现场，只维护指定机器。

每次变更后更新第1、3、11节及相关策略节（如第8.3节）：机器、版本/协议、日期、证书指纹、端口、备份位置和验收结果。真实秘密仍放密码管理工具。所有“未验收”只在获得实际结果后改为通过。

最终长期默认要求：后续新建/重建/迁移Ubuntu部署Claude Code时，首次启动前持久设置三个独立开关`DISABLE_TELEMETRY=1`、`DISABLE_ERROR_REPORTING=1`、`DISABLE_AUTOUPDATER=1`并移除总开关，保留订阅额度查询及CC本机OpenTelemetry配置；启动、升级或恢复后复核。此前要求的总开关默认方案已被此新目标取代。

当前推广进度：六台均已完成三个独立开关切换，配置核对与切换后公网证书/健康通过；第一台CC额度恢复且历史调用统计保留，02～06账号/额度未单独验收。无需重复配置，新统计增长仍待正常使用验证。不能把旧总开关重新叠加到已切换机器。

总开关会阻止独立订阅额度查询，第一台曾出现CC无窗口且`/usage`加载失败、网页有数据的表现，切换为独立开关后CC显示已恢复，见第8.3.4节；后续不要把这种限制误判为账号失效或要求重新登录。

来源与参考：

- 原交接文件：《五台Ubuntu与搬瓦工中转-进度交接与续做指南.md》（2026-10-22，作为历史依据保留）。
- 本次部署记录：[five-ubuntu-deployment-status.zh-CN.md](five-ubuntu-deployment-status.zh-CN.md)。
- 原搬瓦工指南：[bandwagon-relay-setup.zh-CN.md](bandwagon-relay-setup.zh-CN.md)，含旧原机替换方案；不要将该替换分支直接套到现有六台并存部署。
- [CC发布页](https://github.com/sun168567/cc-desk-tunnel/releases)、[部署手册](https://github.com/sun168567/cc-desk-tunnel/blob/main/deploy/README.md)。
- [Ubuntu Server安装器说明](https://canonical-subiquity.readthedocs-hosted.com/en/latest/tutorial/operate-server-installer.html)。

| 日期 | 记录 |
| --- | --- |
| 2026-10-22 | 合并原交接、03～06实际部署结果与相关维护指南；更新为02～06均已部署，补全密钥路径区别、备份恢复、续期升级、排错及待验收事项。 |
| 2026-10-22 | 按用户明确范围改为六台正式维护，补入第一台独立档案、当前VPS授权、公钥、健康检查分支、备份差异、Hyper-V查询与验收行；原机未核实的CC布局继续标明待确认。 |
| 2026-10-22 | 后续已确认第一台Docker、程序目录及数据挂载；六台均完成官方非必要流量总开关配置、备份环境文件、重启与公网证书/健康核对；本机统计实际增长仍待验证。 |
| 2026-10-22 | 更新02当前IP为172.28.152.86，补入Hyper-V地址为空的控制台定位方法；统一第一台已确认路径的操作说明，补齐总开关核对/取消步骤与仓库隐私验证边界。完整备份及操作系统重启恢复仍未实测。 |
| 2026-10-22 | 按用户长期要求，将官方非必要流量总开关设为后续所有新Ubuntu的Claude Code默认部署项；首次启动前写入，保留CC本机统计，并在启动/升级/恢复后核对。首次安装示例与交接要求已同步。 |
| 2026-10-22 | 补记第一台CC订阅额度窗口为空、网页有数据、原生/usage加载失败；查到上游#71886及仓库协作者对总开关抑制额度查询的解释。维持总开关策略，额度暂看官网，本机统计增长仍待验证。 |
| 2026-10-22 | 用户随后要求保留额度查询，第一台改为三个官方独立开关并移除总开关；配置及公网健康通过，CC订阅额度已恢复、历史统计仍保留。最终默认策略及首次部署示例已同步，02～06待逐台切换。 |
| 2026-10-22 | 02已移除总开关并设置三个独立开关，备份、重启及容器env-file解析通过；切换后公网证书指纹匹配、HTTP 200、协议19。03～06待切换，02账号/额度及新统计增长未单独验收。 |
| 2026-10-22 | 03已移除总开关并设置三个独立开关，备份、重启及容器env-file解析通过；切换后公网证书指纹匹配、HTTP 200、协议19。04～06待切换，03账号/额度及新统计增长未单独验收。 |
| 2026-10-22 | 04已移除总开关并设置三个独立开关，备份、重启及容器env-file解析通过；切换后公网证书指纹匹配、HTTP 200、协议19。05～06待切换，04账号/额度及新统计增长未单独验收。 |
| 2026-10-22 | 05已移除总开关并设置三个独立开关，备份、重启及容器env-file解析通过；切换后公网证书指纹匹配、HTTP 200、协议19。06待切换，05账号/额度及新统计增长未单独验收。 |
| 2026-10-22 | 06已移除总开关并设置三个独立开关，备份、重启及容器env-file解析通过；切换后公网证书指纹匹配、HTTP 200、协议19。至此六台切换完成；第一台CC额度已恢复，02～06账号/额度及六台新统计增长未单独验收。 |
| 2026-10-22 | 完成最终配置复核：修正两处旧阶段说明，现用策略、新机示例与维护脚本一致；维护脚本及四段相关Bash语法通过，临时样本验证手册写入步骤保留其他配置且备份原文，维护脚本Python转换保留其他配置并可重复执行。本次未重启远端或修改应用源码，未将配置检查记为本机统计增长验收。 |
