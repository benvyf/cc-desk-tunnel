# 网页代理远端联调记录

2026-10-26，香港时间。依据已选定的[本地浏览器、Ubuntu出口设计](superpowers/specs/2026-10-25-local-browser-remote-egress-design.md)开始真实链路验收。本记录只列已观察到的结果，不把本地回环测试当作远端通过。

## 已完成的只读核查

- 当前网页功能源码为 `0ef9f1f`；工作树检查时干净。没有部署或发布这一分支。
- 本机已安装客户端保存的连接入口是 `wss://74.82.201.214:8443/ws`，配置有固定服务证书指纹。检查只提取地址及指纹是否存在，没有解密或输出保存的服务凭据。
- VPS实际监听：公网8443由socat转发至回环28787；28787由sshd监听。它是既有业务转发，不是Ubuntu的SSH管理入口。未更改监听、SSH转发或防火墙。
- 本机通过已有固定服务证书校验后查询该入口，`/health`返回HTTP200、`status:ok`、协议20；`/cc-browser/v2/status`返回HTTP404。两次请求未发送真实服务凭据，不启动Claude或JEV请求。当前公网服务尚不能用于新网页代理验收。

## 当前步骤：Ubuntu只读检查

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

## 后续验收条件

取得Ubuntu输出后，再准备使用当前代理源码的独立测试服务、独立凭据和本地测试profile。测试服务不挂载生产数据、浏览器登录目录或Docker socket；不修改生产审核策略。使用经过核验的自有HTTPS测试站，所有测试目标由明确白名单限制，不访问Claude。

接入方式必须先核对既有SSH转发的配置与权限，不能把当前公网8443改指到测试服务，也不新增裸露的公网代理端口。当前尚未建立测试服务的本机到Ubuntu管理或业务路由。

完整验收需要测试站记录实际源IP和请求标识，并对照本机、Ubuntu两侧的连接记录。覆盖HTTPS/WSS、远端DNS、IPv4/IPv6、上传下载、新窗口、worker及断线/认证失败/证书错误；检查故障时没有本机直连、旧任务恢复或重复提交。若某项环境不具备条件，记录为未验证，不填通过。

本机、Ubuntu和远端Windows可能有相同公网IP，因此单独比较“查IP网页”不构成出口证明；必须结合两侧连接记录和Ubuntu代理收到的对应请求判断。代理转发原始TLS，测试站证书仍须由浏览器正常验证，不关闭验证或安装系统根证书。

只有隔离联调通过后才讨论真实生产接入。现有强制审核准入仍保留；自有站联调成功不代表已经解决真实Chat的审核覆盖、官网登录、账号区隐藏或安装器验收。
