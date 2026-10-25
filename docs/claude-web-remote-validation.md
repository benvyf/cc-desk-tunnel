# 网页代理远端联调记录

2026-10-26，香港时间。依据已选定的[本地浏览器、Ubuntu出口设计](superpowers/specs/2026-10-25-local-browser-remote-egress-design.md)开始真实链路验收。本记录只列已观察到的结果，不把本地回环测试当作远端通过。

## 已完成的只读核查

- 当前网页功能源码为 `0ef9f1f`；工作树检查时干净。没有部署或发布这一分支。
- 本机已安装客户端保存的连接入口是 `wss://74.82.201.214:8443/ws`，配置有固定服务证书指纹。检查只提取地址及指纹是否存在，没有解密或输出保存的服务凭据。
- VPS实际监听：公网8443由socat转发至回环28787；28787由sshd监听。它是既有业务转发，不是Ubuntu的SSH管理入口。未更改监听、SSH转发或防火墙。
- 本机通过已有固定服务证书校验后查询该入口，`/health`返回HTTP200、`status:ok`、协议20；`/cc-browser/v2/status`返回HTTP404。两次请求未发送真实服务凭据，不启动Claude或JEV请求。当前公网服务尚不能用于新网页代理验收。

## Ubuntu只读检查

通过UU进入远端Windows，再进入 `ubuntu-cc` 普通管理员终端执行：

```bash
hostname
free -m
df -h /
python3 --version
command -v tcpdump || true
ip route show default
sudo docker ps --format '{{.Names}} | {{.Status}}'
sudo docker inspect --format '{{.Image}}' cc-desk-tunnel-ba938975-proxy-1
sudo docker exec cc-desk-tunnel-ba938975-proxy-1 /opt/runtime/node/bin/node -p 'process.version'
ss -lnt '( sport = :22 or sport = :8787 or sport = :18789 )'
```

这些命令只读取资源、网络、容器身份及Node版本。docker exec只运行一个打印版本的Node进程，不执行CC入口或CLI。若已有容器名称变化或Node路径不存在，保留错误输出反馈，不重装、重启或自行替换生产容器。不需要回传密码、服务token、Cookie或完整配置文件。

管理员回传结果：总内存1902MiB、可用1428MiB，根分区剩余3.3GiB；Python3.12.3、tcpdump可用。默认路由从eth0经172.22.240.1，源地址172.22.248.220。生产容器健康，镜像完整身份为 `sha256:365918cb8abf4f4b784502a6bbabeda5704dc928e5c899438199776001b1adb2`，其中Node为24.21.0。Ubuntu回环测试端口18789未监听。

## 当前步骤：隔离测试隧道

依据[远端验收计划](superpowers/plans/2026-10-26-browser-remote-validation.md)，管理员在Ubuntu生成独立测试密钥，仅回传公钥。私钥留在Ubuntu测试目录，没有复制到本机或VPS。

VPS已创建专用 `cc-egress-lab` 账号，只接受该公钥，公钥授权到VPS时间2026-10-27T16:15:23Z为止。有效sshd策略为：仅远端TCP转发、只允许监听127.0.0.1:38789、GatewayPorts关闭、PermitOpen为none、MaxSessions为0，禁止密码/交互认证、终端、agent、X11、TUN、Unix socket转发及用户RC。`-R`在Ubuntu一侧的目的地址及45分钟生命周期由固定管理员命令约束，OpenSSH服务端的PermitListen本身不能约束客户端选取的目的地址。

配置经过独立审查和VPS实际sshd语法/有效配置检查，25个既有系统账号的有效配置逐一比较无变化。配置替换保留权限和属主、采用原子替换；失败先撤销公钥，再分别尝试恢复和清理。回滚支持已恢复配置后的重试；遇并行配置修改时拒绝覆盖。受审安装与回滚脚本保存在VPS root专用目录 `/root/cc-egress-tunnel-20261026`，回滚入口为 `python3 /root/cc-egress-tunnel-20261026/rollback.py`。未通过root之外的账号实际执行登录/拒绝测试，须在管理员连接后补验。

安装后重新建立root管理SSH成功，sshd状态active且配置检查通过，8443及28787–28792原监听仍在。使用已保存服务证书指纹、不读取真实服务token的健康请求返回HTTP200、status=ok、协议20。

管理员执行固定命令后，已观察到专用账号的sshd进程及其 `127.0.0.1:38789` 监听，未出现对应公网或IPv6监听；现有8443/28787进程仍为原PID，健康检查再次返回HTTP200、status=ok、协议20。公钥认证和远端监听建立已实测通过。

随后管理员在Ubuntu回环18789运行单次、固定标记服务。VPS经38789发送固定测试标记，收到完全匹配的预期响应，结果为 `TUNNEL_ROUNDTRIP_PASS VPS_LOOPBACK_TO_UBUNTU_LOOPBACK`。单次服务收发后退出。该结果证明测试通道的数据往返，不代表浏览器/目标网站出口通过。禁止操作的实际负向SSH测试仍待补验。

## 独立代理的实际启动及认证检查

新增[独立代理测试包](browser-egress-lab.md)，入口只加载现有v2代理及其两个依赖，不加载生产server、native agent或旧RFB服务。源码审查发现并修复了root所有的cidfile清理、sudo过期及镜像快照继承环境变量问题；最终独立审查无重要/严重未修复项。Node24的19项定向测试和5种启动边界场景通过。实际私有包的10个文件、逐文件清单和SHA256均已核验。

私有包只通过本机→已验证root管理SSH→VPS回环38789→Ubuntu回环18789发送，没有公网下载地址。Ubuntu接收程序验证完整包SHA256、只解压普通文件并收紧权限后，回复 `PACKAGE_RECEIVED_OK`；发送端得到 `PACKAGE_DELIVERY_VERIFIED`。私钥、token和本地client.json没有输出到聊天、测试日志或Git。

管理员实际启动返回 `EGRESS_LAB_READY`，本轮到期时间为2026-10-25T17:21:36.599Z（香港时间2026-10-26 01:21:36）。这确认原镜像的Node24/依赖布局能启动当前代理；启动器清空镜像环境变量、遮住已知数据路径并拒绝未知声明数据卷。该结论不等于镜像历史文件已完整审计。

本机另建只监听127.0.0.1:18789的root管理SSH本地转发，目的为VPS127.0.0.1:38789。使用真实客户端的secure-service和browser-network-proxy模块、独立凭据和证书指纹检查，实际结果全部通过：

- 固定证书指纹下，独立健康接口HTTP200、status=synthetic-egress-lab；有效凭据的v2状态HTTP200、schema=2、enabled=true。
- 缺失/错误凭据均HTTP401；错误证书指纹在发送服务凭据前被客户端拒绝。
- 本机CONNECT未认证返回407；内网IP目标和错误端口返回403；已认证但不在固定白名单内的域名经Ubuntu拒绝，本机返回502。

这些检查未请求任何网站目标连接，也没有网页上传、下载或Claude流量。真实网页TLS、远端DNS、出口抓包、Electron浏览器、断线、IPv6和其他协议仍属后续验收，不能用当前控制通道结果代替。

## 后续验收条件

取得Ubuntu输出后，再准备使用当前代理源码的独立测试服务、独立凭据和本地测试profile。测试服务不挂载生产数据、浏览器登录目录或Docker socket；不修改生产审核策略。使用经过核验的自有HTTPS测试站，所有测试目标由明确白名单限制，不访问Claude。

接入方式已核对既有SSH转发的配置与权限，不能把当前公网8443改指到测试服务，也不新增裸露的公网代理端口。本机到Ubuntu的独立测试通路尚待管理员建立并验证；没有新增Ubuntu管理SSH入口。

完整验收需要测试站记录实际源IP和请求标识，并对照本机、Ubuntu两侧的连接记录。覆盖HTTPS/WSS、远端DNS、IPv4/IPv6、上传下载、新窗口、worker及断线/认证失败/证书错误；检查故障时没有本机直连、旧任务恢复或重复提交。若某项环境不具备条件，记录为未验证，不填通过。

本机、Ubuntu和远端Windows可能有相同公网IP，因此单独比较“查IP网页”不构成出口证明；必须结合两侧连接记录和Ubuntu代理收到的对应请求判断。代理转发原始TLS，测试站证书仍须由浏览器正常验证，不关闭验证或安装系统根证书。

只有隔离联调通过后才讨论真实生产接入。现有强制审核准入仍保留；自有站联调成功不代表已经解决真实Chat的审核覆盖、官网登录、账号区隐藏或安装器验收。
