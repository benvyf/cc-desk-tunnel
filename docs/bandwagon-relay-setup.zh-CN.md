# CC Desk Tunnel：CC 配置与搬瓦工中转设置指南

> 历史归档：本文保留早期链路与安装说明。后续客户端、邮箱授权、服务端版本及升级状态以 [最新开发交接](../DEVELOPMENT-HANDOFF.md) 为准，旧安装命令不作为当前升级指令。

> 六台Ubuntu（原机ubuntu-cc及02～06）的当前部署结果与后续维护，已统一整理到[六台部署与维护手册](六台Ubuntu与搬瓦工中转-部署与维护手册.md)。本页保留原机配置及历史安装/替换方案；其中示例的服务名和端口不能直接覆盖现用六台配置。

核对日期：2026-10-21。适用于当前搬瓦工 `74.82.201.214`，以及新建 Ubuntu 后重新接入中转。Ubuntu 命令以 24.04 LTS 为例。

本文中的新机步骤是操作指南，尚未在任何新 Ubuntu 上执行；当前生产链路已实际连通验证。文中不包含服务凭据、模型 API key 或私钥。

完整安装顺序：第 5 节配置 Ubuntu CC 服务 → 第 6～7 节接入搬瓦工 → 第 8 节安装并配置本地 CC、登录模型账号、添加项目及验证。两台 Ubuntu 并存先看第 10 节；要迁移旧会话而非全新安装，先看第 12 节。

需要区分三类凭据：CC 服务凭据用于客户端连接 Ubuntu；SSH 密钥用于 Ubuntu 接入搬瓦工；Claude 登录 / 模型 API key 用于调用模型。三者不能互相替代。

## 1. 当前网络链路

```text
中国大陆移动宽带
本地 Windows：CC 客户端、项目文件、PowerShell
    ⇅ WSS：认证、对话、审批，以及独立的执行通道连接
搬瓦工 74.82.201.214:8443
    ⇅ socat TCP 转发，两个方向均启用 TCP_NODELAY
搬瓦工 127.0.0.1:28787
    ⇅ 反向 SSH 端口转发，连接由马来西亚 Ubuntu 主动建立
马来西亚 Ubuntu 127.0.0.1:8787（HTTPS）
    ⇅
CC 服务 + 官方 Agent SDK + Claude Code
    ⇅ 模型请求，沿用之前配置的远端 Windows 出口
马来西亚远端 Windows 出口
    ⇅
模型服务
```

执行 Windows 命令的逻辑路径：

```text
Ubuntu 上的 Claude Code
    ⇅ 原项目的 SSH 执行协议，封装在 WSS 内
搬瓦工中转
    ⇅
本地 Windows 的回环 SSH 服务
    ⇅
读写本地项目 / 执行 PowerShell / 将结果传回 Ubuntu
```

这里有两种 SSH：Ubuntu 到搬瓦工的反向 SSH 用于提供公网接入；原项目的执行 SSH 用于操作本地 Windows，两者用途不同。

搬瓦工仅转发 TCP 字节，不运行 CC 服务，不终止这条 WSS 的 TLS。客户端校验的是 Ubuntu CC 服务的证书。Funnel 公网入口已关闭。

相较原项目，新增的是“搬瓦工公网入口 + Ubuntu 主动建立的反向 SSH 隧道”；Linux 运行 agent、Windows 执行项目操作的分工保持原样。

## 2. 当前部署参数

| 项目 | 当前值 |
|---|---|
| 搬瓦工公网 IP | `74.82.201.214` |
| 搬瓦工运维 / 隧道 SSH 端口 | `22/TCP` |
| CC 公网入口 | `wss://74.82.201.214:8443/ws` |
| 搬瓦工公网监听 | `0.0.0.0:8443` |
| 搬瓦工反向隧道监听 | `127.0.0.1:28787`，不向公网开放 |
| Ubuntu CC 上游 | `https://127.0.0.1:8787` |
| 搬瓦工专用 SSH 用户 | `ccdesk-relay` |
| 搬瓦工服务 | `ccdesk-relay.service` |
| Ubuntu 服务 | `cc-bwg-relay.service` |
| 当前 Ubuntu 用户 | `benben` |
| 当前 Ubuntu 隧道私钥 | `/home/benben/.ssh/cc-hk-relay-test`，沿用旧文件名 |
| 搬瓦工 TCP 拥塞控制 | `bbr`，队列调度 `fq` |
| 转发 TCP_NODELAY | socat 两侧已开启 |

当前 Ubuntu CC 证书 SHA256 指纹：

```text
7C:08:EE:9E:AA:52:B3:9B:DA:F6:4B:63:FB:FD:BE:16:3B:46:14:51:9D:A3:15:C5:B5:F6:8A:1E:A1:83:A8:2E
```

搬瓦工 SSH 的 ED25519 主机密钥指纹：

```text
SHA256:Q7TmQOsYoY+V4agj8p2bwHx5qICS3gBqt0NIan/38to
```

这两个指纹用途不同，不能互填。重建 Ubuntu 一般会产生新的 CC 证书和服务凭据；重装搬瓦工可能改变 SSH 主机密钥。

## 3. 搬瓦工当前是怎么配置的

本节记录现状。当前搬瓦工已配置完成，给新 Ubuntu 接入时无需重建本节的现有服务。

`/etc/systemd/system/ccdesk-relay.service`：

```ini
[Unit]
Description=CC Desk Tunnel TLS passthrough relay
After=network.target

[Service]
User=ccdesk-relay
ExecStart=/usr/bin/socat TCP4-LISTEN:8443,bind=0.0.0.0,reuseaddr,fork,nodelay TCP4:127.0.0.1:28787,nodelay
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

已安装 `socat`，服务已启用开机启动；UFW 已放行 `8443/TCP`。云平台如果另有防火墙 / 安全组，也需放行对应公网入口。现有网站的 `80/443` 不用于这条中转。

专用用户 `ccdesk-relay` 的 home 是 `/var/lib/ccdesk-relay`，使用公钥登录。当前公钥位于：

```text
/var/lib/ccdesk-relay/.ssh/authorized_keys
```

当前授权包含 `restrict,port-forwarding`，只允许该密钥绑定 `127.0.0.1:28787`，并限制普通命令只能返回现有安装脚本。当前安装脚本位于：

```text
/usr/local/share/ccdesk-relay/install-ubuntu.sh
```

**不要直接把旧的 `ssh ... setup | sudo bash` 接入命令用于新 Ubuntu。** 旧脚本固定使用 `benben`、旧密钥文件名和 `28787`，并且不会自动把新机公钥加到搬瓦工。新机按下面步骤生成新密钥并接入。

## 4. 新 Ubuntu 接入前，先选替换还是并存

| 目的 | 公网入口端口 | 搬瓦工回环端口 | 是否需要停止旧隧道 |
|---|---:|---:|---|
| 替换旧 Ubuntu，保留当前地址 | `8443` | `28787` | 是，在新机启动隧道前停止 |
| 新旧 Ubuntu 同时使用 | 新机用 `8444` | 新机用 `28788` | 否；按第 10 节加第二套转发 |

下面第 5～9 节以“替换旧 Ubuntu，继续使用 `8443/28787`”为例。同一个回环端口不能同时由两台 Ubuntu 的隧道占用。

## 5. 在新 Ubuntu 上准备 CC HTTPS 服务

如果新机已经安装 CC，且 `https://127.0.0.1:8787/health` 能正常返回，则跳过安装，继续检查证书和模型出口。

### 5.1 安装服务端及其运行组件

全新 Ubuntu 可先安装依赖：

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 openssh-client curl openssl ca-certificates python3 nano
sudo systemctl enable --now docker
```

按原项目安装服务：

```bash
curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh -o /tmp/cc-desk-tunnel-install.sh
sudo bash /tmp/cc-desk-tunnel-install.sh
```

安装时使用以下参数：

- 公网地址填 `74.82.201.214`。
- 入口选择“自签证书 / 指纹”模式；本方案的 Ubuntu 上游必须是 HTTPS。
- 服务端口填 `8787`。
- 程序目录采用默认 `/opt/cc-desk-tunnel`，数据目录采用 `/srv/cc-desk-tunnel`。
- 保存安装输出的服务凭据和证书指纹。最终客户端公网地址使用 `8443`，不要照填默认输出中的 `8787`。

安装脚本会构建 Docker 镜像，镜像内包含 Node.js、官方 Claude Code、Agent SDK 和执行所需组件。采用这条部署路径，不需要再在 Ubuntu 宿主机上单独 `npm install -g` 安装 Claude Code。首次构建需能访问 GitHub、系统软件源和 npm。

### 5.2 配置回环 HTTPS 入口

对于原项目的默认 Docker 部署，在 `/opt/cc-desk-tunnel/.local/docker.env` 中，将下面两项设置为：

```sh
CONTROL_BIND='127.0.0.1'
CONNECTION_URL='wss://74.82.201.214:8443/ws'
```

其余配置保留，然后重新应用容器配置：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh up
```

`CONTROL_BIND` 限制宿主机的端口发布，不要把容器内部监听也改成回环。无需为 Ubuntu 的 `8787` 开公网入站端口。

默认数据目录下，检查本机 HTTPS 和证书：

```bash
sudo openssl x509 -in /srv/cc-desk-tunnel/tls/control.crt -noout -fingerprint -sha256
sudo curl --noproxy '*' --cacert /srv/cc-desk-tunnel/tls/control.crt \
  --resolve cc-desk-tunnel.local:8787:127.0.0.1 \
  https://cc-desk-tunnel.local:8787/health
```

原项目自签模式使用 `cc-desk-tunnel.local` 证书名。若你的证书使用其他名称，替换上面命令中的主机名；自定义数据目录也要相应替换。健康结果应包含 `"status":"ok"`。

### 5.3 取回连接参数、查看服务状态

在新 Ubuntu 本人控制的终端执行：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh status
sudo bash deploy/manage.sh connection
```

`connection` 会显示服务地址、证书 SHA256 指纹和 `PROXY_TOKEN`。客户端“服务凭据”填 `PROXY_TOKEN` 的值，不包含变量名及外层引号。该命令会显示真实凭据，保存在自己的密码管理工具中即可，不要粘贴进工单。

按本指南修改过 `CONNECTION_URL` 后，显示的地址应为 `wss://74.82.201.214:8443/ws`。如果是第二台并存 Ubuntu，则是 `8444`。

### 5.4 配置模型请求从远端 Windows 出去

**模型出口需单独配置。** 这条反向 SSH 只转发 CC 的服务端口，不会让新 Ubuntu 的模型请求自动走远端 Windows。若继续要求模型从马来西亚远端 Windows 的 IP 出去，应复用旧机实际使用的代理 / 路由设置，并确认容器中的 Claude Code 也使用该出口。模型配置文件默认是 `/srv/cc-desk-tunnel/config/provider.json`；该文件本身不等同于完整的代理与路由配置。

如果新 Ubuntu 是马来西亚 Windows 上的 Hyper-V 虚拟机，可先采用与旧 Ubuntu 相同的虚拟交换机 / NAT 网络。Windows 自身直接联网、Ubuntu 经它 NAT 出网时，通常共享该 Windows 的公网出口；不必为了中转额外增加一层模型代理。

在**马来西亚远端 Windows 的 PowerShell**中查看直连公网地址：

```powershell
curl.exe -4 --noproxy '*' --silent --show-error --max-time 15 https://api.ipify.org
```

在**新 Ubuntu**查看宿主及容器的直连公网地址：

```bash
curl -4 --noproxy '*' --silent --show-error --max-time 15 https://api.ipify.org
cd /opt/cc-desk-tunnel
cc_project="$(sudo sed -n "s/^PROJECT_NAME='\(.*\)'$/\1/p" .local/docker.env)"
sudo docker compose --env-file .local/docker.env -p "$cc_project" \
  -f deploy/docker/compose.yaml exec -T proxy \
  curl -4 --noproxy '*' --silent --show-error --max-time 15 https://api.ipify.org
```

这三个结果用于核对默认 IPv4 出口。`--noproxy '*'` 排除 curl 的显式代理，但不会绕过系统 TUN / VPN；若 Claude Code 单独配置了代理，这项检查也不能证明它实际调用模型时的出口，需要按那套代理配置另行核对。

只有确实通过远端 Windows 的 HTTP 代理出网时，才在 `provider.json` 的 `env` 中添加 `HTTP_PROXY` / `HTTPS_PROXY`，地址填容器可访问的远端 Windows 内网地址和真实代理端口。不要填 `127.0.0.1`，它在容器中指向容器自己；修改时保留原有模型配置。代理只向所需内网开放。本文不预填旧机未经核实的代理地址或端口。

如果还要保留旧会话、Claude 登录和长期上下文，使用原项目的备份 / 恢复流程；仅接入中转不会迁移这些数据。参考原项目 [部署手册](https://github.com/sun168567/cc-desk-tunnel/blob/main/deploy/README.md)。

## 6. 在新 Ubuntu 上生成密钥，登记到搬瓦工

### 6.1 新 Ubuntu：用日常登录用户执行，不要加 sudo

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
test -f ~/.ssh/cc-bwg-relay || ssh-keygen -t ed25519 -N '' -f ~/.ssh/cc-bwg-relay -C cc-new-ubuntu-relay
cat ~/.ssh/cc-bwg-relay.pub
```

复制最后一行完整公钥，内容以 `ssh-ed25519` 开头。私钥留在新 Ubuntu。

### 6.2 搬瓦工：通过 root 运维终端追加新公钥

当前搬瓦工已经有专用用户及目录。执行下面命令，按提示粘贴新 Ubuntu 公钥：

```bash
read -r -p '粘贴新 Ubuntu 的完整 ssh-ed25519 公钥：' cc_new_pubkey
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:28787",permitopen="127.0.0.1:28787",command="/bin/false" %s\n' "$cc_new_pubkey" >> /var/lib/ccdesk-relay/.ssh/authorized_keys
chown ccdesk-relay:ccdesk-relay /var/lib/ccdesk-relay/.ssh/authorized_keys
chmod 600 /var/lib/ccdesk-relay/.ssh/authorized_keys
```

新公钥只用于端口转发，不提供交互 shell，也不使用旧安装脚本。`ssh -N` 不申请远程命令，因此可正常建立隧道。

### 6.3 新 Ubuntu：核对搬瓦工 SSH 主机密钥

```bash
ssh-keyscan -T 10 -p 22 -t ed25519 74.82.201.214 > ~/.ssh/cc-bwg-hostkey
ssh-keygen -lf ~/.ssh/cc-bwg-hostkey
```

确认输出指纹与第 2 节的搬瓦工 SSH 指纹完全一致，再登记：

```bash
cat ~/.ssh/cc-bwg-hostkey >> ~/.ssh/known_hosts
chmod 600 ~/.ssh/known_hosts
```

`ssh-keyscan` 只负责获取密钥，独立核对指纹才完成信任确认。若不一致，先从搬瓦工控制台核实是否重装过系统，不要直接接受。

## 7. 替换时停止旧隧道，并在新 Ubuntu 创建常驻服务

先完成新机本地健康检查和公钥登记，再在**旧 Ubuntu**执行：

```bash
sudo systemctl disable --now cc-bwg-relay.service
```

从这里开始旧入口会暂时不可用。接下来在**新 Ubuntu 的日常登录用户终端**执行以下完整代码块，自动使用新机当前用户名和 home：

```bash
cc_relay_user="$(id -un)"
cc_relay_home="$(getent passwd "$cc_relay_user" | cut -d: -f6)"

sudo tee /etc/systemd/system/cc-bwg-relay.service > /dev/null <<UNIT
[Unit]
Description=CC Desk Tunnel SSH relay to Bandwagon VPS
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=exec
User=$cc_relay_user
ExecStart=/usr/bin/ssh -NT -i $cc_relay_home/.ssh/cc-bwg-relay -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$cc_relay_home/.ssh/known_hosts -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 127.0.0.1:28787:127.0.0.1:8787 ccdesk-relay@74.82.201.214
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemd-analyze verify /etc/systemd/system/cc-bwg-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now cc-bwg-relay.service
sudo systemctl status cc-bwg-relay.service --no-pager
```

参数含义：

- `-NT`：只转发，不申请 shell 或终端。
- `-R 127.0.0.1:28787:127.0.0.1:8787`：搬瓦工回环 `28787` 收到的数据，通过 SSH 送到新 Ubuntu 自己的 `8787`。
- `ExitOnForwardFailure=yes`：端口被占用等情况直接失败，让 systemd 重试，避免假运行。
- `ServerAliveInterval=15`、`ServerAliveCountMax=3`：检测失效连接；systemd 退出后等 5 秒重连。不是降低网络延迟的参数。
- SSH 压缩保持默认关闭；此处承载的是加密 TLS 数据。

## 8. 验证完整公网链路，填写本地 CC

### 8.1 搬瓦工检查

```bash
systemctl is-active ccdesk-relay.service
ss -ltnp '( sport = :8443 or sport = :28787 )'
```

应同时看到公网 `8443` 和回环 `28787`。`28787` 由新 Ubuntu 的 SSH 隧道建立。

### 8.2 新 Ubuntu 通过公网入口检查

```bash
sudo curl --noproxy '*' --cacert /srv/cc-desk-tunnel/tls/control.crt \
  --resolve cc-desk-tunnel.local:8443:74.82.201.214 \
  --connect-timeout 5 --max-time 15 \
  https://cc-desk-tunnel.local:8443/health
```

应返回 `"status":"ok"`。这一步会核验证书，并覆盖“Ubuntu → 搬瓦工公网入口 → 反向 SSH → Ubuntu CC”的路径；最后仍需从本地 Windows 连接，确认本地这段线路也正常。

### 8.3 安装并连接本地 Windows CC

1. 打开 [原项目 Releases](https://github.com/sun168567/cc-desk-tunnel/releases)，下载与 Ubuntu 服务端配套的 `CC-Desk-Tunnel-Setup-版本-x64.exe` 并安装；已安装当前客户端可直接使用。
2. 启动 CC Desk Tunnel。在连接页填入以下三项。安装版不需要本地另外安装 Node.js、Claude Code 或系统 SSH 服务。

| 字段 | 填写内容 |
|---|---|
| 服务地址 | `wss://74.82.201.214:8443/ws` |
| 服务证书指纹 | **新 Ubuntu** 的 `control.crt` SHA256 指纹 |
| 服务凭据 | **新 Ubuntu** 的 CC 安装凭据 |

新安装不要照抄第 2 节的旧 CC 证书指纹，也不要把 SSH 主机指纹或 SSH 登录密码填进来。只有完整恢复了旧证书和服务凭据时，客户端才可继续沿用原来的值。

3. 按需勾选“记住凭据”；希望下次启动直接连接时再勾选“自动登录”。记住的凭据通过当前 Windows 用户加密保存。
4. 点击“连接”。客户端会自动准备本地回环 SSH 组件并等待服务端执行通道探测完成，之后进入工作区。
5. 新旧 Ubuntu 并存时，到“设置 → 常规 → 多个连接”中使用“新建连接”，给第二台单独起名，在新窗口填写 `8444` 地址及第二台的指纹 / 凭据，保留原来的连接。

`/health` 只证明 CC 服务可达，不证明模型登录、模型出口或 Windows 执行通道全部正常。

本地 Windows 如果使用 Clash TUN，保留当前规则，并放在会命中代理的规则前：

```text
IP-CIDR,74.82.201.214/32,DIRECT,no-resolve
```

这是当前大陆移动到搬瓦工的直连设置。仅添加到临时运行配置可能在重启后丢失，应写入持久规则 / 配置脚本。当前本机已经持久配置，无需重复添加。

### 8.4 配置 Claude 账号或模型 API

CC 的服务连接成功后，还需要配置 Ubuntu 内的 Claude Code 如何访问模型。按自己使用的方式选择下面一种。

**方式 A：官方 Claude 账号登录。**

1. 本地 CC 打开“设置 → 账号与额度”。
2. 未登录时点击“登录”，再点击“打开授权页”。
3. 在浏览器完成自己的账号授权，将授权页给出的代码填入 CC 的“授权码”，点击“完成登录”。
4. 刷新账号信息；新建一个会话，确认模型选择器能够读取可用模型。账号登录保存在 Ubuntu 的持久数据中，不是保存在搬瓦工。

采用此方式时，`provider.json` 不需要填模型 API key；全新安装默认的 `{}` 即可。若之前配置了其他认证或提供方环境变量，应先确认是否仍需保留，避免两套配置相互影响。

**方式 B：模型提供方 API。**

在新 Ubuntu 编辑配置文件：

```bash
sudo nano /srv/cc-desk-tunnel/config/provider.json
```

下面是使用 Anthropic 兼容接口、Bearer token 的提供方配置示例，所有示例值都需要替换为提供方实际给出的值：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.example.com",
    "ANTHROPIC_AUTH_TOKEN": "替换为自己的提供方凭据",
    "ANTHROPIC_MODEL": "替换为提供方支持的模型ID"
  }
}
```

若提供方要求 `ANTHROPIC_API_KEY`，用该字段替代示例中的 `ANTHROPIC_AUTH_TOKEN`，按提供方文档配置；不要把 OpenAI 协议接口直接当作 Anthropic 兼容接口填入。CC 连接用的 `PROXY_TOKEN` 也不能作为模型 API key。

编辑完成后检查 JSON 语法，并重启 CC 服务：

```bash
sudo python3 -m json.tool /srv/cc-desk-tunnel/config/provider.json > /dev/null
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh restart
```

然后等待本地 CC 自动重连。API 模式不一定有订阅账号和额度信息，不能单凭账号页是否显示订阅判断 API 是否可用；应实际发送一条消息验证。

模型提供方地址决定“请求发给谁”，第 5.4 节的网络配置决定“请求从哪个 IP 出去”，两者分别配置。

### 8.5 添加本地项目、选择模型与审批方式

1. 在侧栏“项目”旁点击加号，选择**本地 Windows**上的实际项目目录，例如 `D:\MyProject`。无需把整个项目复制到 Ubuntu 或搬瓦工。
2. 在该项目旁创建会话。直接点击“新建会话”得到的是普通会话，会有独立工作目录；默认位于 Windows 文档目录下的 `CC Desk Tunnel`，也可在“设置 → 常规 → 普通会话的文件夹”中修改。
3. 在输入框附近选择当前账号 / 提供方可用的模型和推理强度，不要照搬其他提供方的模型 ID。
4. 审批模式先保留默认值，按弹出的原生权限请求确认。自动压缩、记忆等 Claude Code 选项在“设置 → Claude Code”中调整，不需要为搬瓦工中转单独改动。
5. 点击新建后，按钮会在创建和原生状态读取期间暂时变灰；这不等同于链路断开。

### 8.6 按顺序验证整套 CC 配置

先发送一条普通问题确认模型能够回复，再发送：

```text
请通过本机执行通道，在我的 Windows 上执行 hostname 和 Get-Location，返回结果，不修改文件。
```

返回的机器名应是**本地 Windows**，工作目录应对应所选项目。这样才能同时确认模型调用、WSS 通信和 Windows 命令执行；不要只看模型口头声称执行成功，应查看 CC 展示的实际工具调用和输出。

当前本机的连接日志位于：

```text
C:\Users\99794\AppData\Roaming\CC Desk Tunnel\logs\client.log
```

其他 Windows 用户通常为 `%APPDATA%\CC Desk Tunnel\logs\client.log`，额外连接使用独立 profile 目录。日志中出现 `Connected as ...; commands can run.` 表示连接及执行通道就绪；模型认证问题仍需结合服务端日志查看：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh logs
```

## 9. 切换完成、维护与回退

如果新 Ubuntu 原来还开着 Funnel，确认本地 CC 经搬瓦工完全正常后再关闭其 Funnel 公网入口：

```bash
sudo tailscale funnel --https=443 off
```

未安装 Tailscale 或从未启用 Funnel 的新机无需执行。本方案不依赖本地安装 Tailscale。

Ubuntu 查看和维护隧道：

```bash
sudo systemctl status cc-bwg-relay.service --no-pager
sudo journalctl -u cc-bwg-relay.service -n 60 --no-pager
sudo systemctl restart cc-bwg-relay.service
```

搬瓦工查看和维护转发：

```bash
systemctl status ccdesk-relay.service --no-pager
journalctl -u ccdesk-relay.service -n 60 --no-pager
sysctl net.ipv4.tcp_congestion_control net.core.default_qdisc
```

当前应输出 `bbr`、`fq`。TCP_NODELAY 配置保存在 socat 的 systemd `ExecStart` 中。编辑 unit 后需 `systemctl daemon-reload` 并重启对应服务，重启会短暂中断连接。

替换失败时：先在新 Ubuntu 执行 `sudo systemctl disable --now cc-bwg-relay.service`，再在旧 Ubuntu 执行 `sudo systemctl enable --now cc-bwg-relay.service`。在本地 CC 恢复旧证书指纹和旧服务凭据，即可回到原链路。

## 10. 两台 Ubuntu 同时接入同一个搬瓦工

保留旧 Ubuntu 使用 `8443 → 28787 → 8787`；新增第二条：

```text
本地 CC 的另一个连接
    ⇅ wss://74.82.201.214:8444/ws
搬瓦工 0.0.0.0:8444
    ⇅ socat
搬瓦工 127.0.0.1:28788
    ⇅ 第二台 Ubuntu 主动建立的反向 SSH
第二台 Ubuntu 127.0.0.1:8787
```

在搬瓦工 root 终端创建第二个服务，不修改旧服务：

```bash
cp /etc/systemd/system/ccdesk-relay.service /etc/systemd/system/ccdesk-relay-ubuntu2.service
sed -i 's/8443/8444/g; s/28787/28788/g' /etc/systemd/system/ccdesk-relay-ubuntu2.service
systemd-analyze verify /etc/systemd/system/ccdesk-relay-ubuntu2.service
systemctl daemon-reload
systemctl enable --now ccdesk-relay-ubuntu2.service
ufw allow 8444/tcp comment 'CC Desk Tunnel second Ubuntu'
```

云防火墙 / 安全组若启用，也放行 `8444/TCP`。`28788` 仍只监听回环，无需放行。

然后按第 5～8 节配置第二台 Ubuntu，但做以下替换：

| 位置 | 第二台的值 |
|---|---|
| 第 5 节 `CONNECTION_URL` | `wss://74.82.201.214:8444/ws` |
| 第 6 节新增公钥的 `permitlisten` | `127.0.0.1:28788` |
| 第 6 节新增公钥的 `permitopen` | `127.0.0.1:28788` |
| 第 7 节 systemd 的 `-R` | `127.0.0.1:28788:127.0.0.1:8787` |
| 第 8 节公网健康检查端口 | `8444` |
| 本地第二个 CC 连接地址 | `wss://74.82.201.214:8444/ws` |
| 本地第二个 CC 连接证书 / 凭据 | 第二台自己的证书指纹 / 服务凭据 |

**并存时不要执行第 7 节停止旧 Ubuntu 隧道的命令。** 两台不同 Ubuntu 上，systemd 服务都叫 `cc-bwg-relay.service` 没有冲突；搬瓦工上的两个转发服务名称必须不同。

## 11. 常见问题

| 现象 | 检查位置与处理 |
|---|---|
| `Permission denied (publickey)` | 新机私钥是否正确；新公钥是否登记到 `ccdesk-relay`，而不是只加到 root；搬瓦工是否启用公钥认证 |
| `remote port forwarding failed` | 是否旧机还占用 `28787`；授权里的 `permitlisten` 是否与 `-R` 端口一致；两台并存应使用不同端口 |
| SSH 报主机密钥变化 | 从搬瓦工控制台核对新主机指纹后再更新 `known_hosts` |
| Ubuntu 服务 active，但公网访问失败 | `Type=exec` 的 active 不代表远程绑定已完成；查看 journal，再检查回环监听、上游健康及防火墙 |
| `8443` 可连，但提示证书不匹配 | 是否指向了另一台 Ubuntu；是否沿用了旧指纹；新证书是否已更新到客户端 |
| `/health` 正常，但 CC 登录失败 | 服务凭据应来自当前 Ubuntu；SSH 密钥与 CC 服务凭据是两回事 |
| CC 可以连接，但模型访问失败 | 单独检查新 Ubuntu 容器内的 Claude 登录、提供方配置及远端 Windows 出口 |
| CC 可以聊天，但本地命令失败 | 检查原项目的 WSS 执行通道和本地回环 SSH；新加的公网中转只是外层传输 |
| Clash 开启后变慢 | 检查搬瓦工 IP 是否命中 DIRECT，避免再套一层代理 |

## 12. 搬迁旧 CC 会话、账号和长期上下文

只迁移接入隧道不会迁移 CC 数据。本节适用于**旧机和新机都采用原项目 Docker 部署**；旧机如果使用原生进程 / 自定义部署，应先确认实际数据目录和运行方式，不能直接套用 Docker 管理命令。

### 12.1 旧 Ubuntu 创建完整备份

```bash
sudo mkdir -p /var/backups/cc-desk-tunnel
cd /opt/cc-desk-tunnel
cc_backup="/var/backups/cc-desk-tunnel/cc-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
sudo bash deploy/manage.sh backup "$cc_backup"
```

备份会短暂停止 CC 容器以保持数据一致，完成后恢复原先的运行状态。备份包含 Claude 登录、原生上下文、CC 会话索引、服务凭据和 TLS 私钥，应只在自己控制的机器之间传送。

### 12.2 新 Ubuntu 只初始化，再恢复

迁移分支不要执行第 5.1 节的完整交互 `setup`；先按第 5.1 节安装依赖并下载安装脚本，然后使用 `init`，此时不启动新服务：

```bash
sudo bash /tmp/cc-desk-tunnel-install.sh init \
  --host 74.82.201.214 --mode fingerprint --data /srv/cc-desk-tunnel
```

将旧机备份安全传到新 Ubuntu，以下假设保存为 `/var/backups/cc-desk-tunnel/old-cc.tar.gz`。执行：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh restore /var/backups/cc-desk-tunnel/old-cc.tar.gz
```

恢复只接受新初始化、尚未写入会话 / home / workspace 的空部署。已经运行过新服务的目录可能不再满足条件；应选新的独立程序 / 数据目录按原项目方式初始化，或先处理该新部署已有的数据，不要为强行恢复直接删除目录。

接着按第 5.2 节设置新机 `.local/docker.env` 的回环绑定和 `CONNECTION_URL`，核对恢复的 `config/service.env`、`config/provider.json` 和模型出口，再构建启动：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh build
sudo bash deploy/manage.sh up
sudo bash deploy/manage.sh status
```

最后接第 6～8 节：新 Ubuntu 的 SSH 隧道密钥仍单独生成和授权。完整恢复旧证书 / CC 服务凭据后，可以沿用旧客户端对应值；但如果证书已过期或被重新生成，应按新值更新。原有会话指向的 Windows 项目路径也应仍然存在。

## 13. 参考

- [原项目架构](https://github.com/sun168567/cc-desk-tunnel/blob/main/docs/architecture.md)
- [原项目部署手册与备份恢复](https://github.com/sun168567/cc-desk-tunnel/blob/main/deploy/README.md)
- [原项目端口与 TLS 说明](https://github.com/sun168567/cc-desk-tunnel/blob/main/docs/deployment.md)
