# 五台 Ubuntu CC 与搬瓦工部署结果

> 本页保留为新增五台部署完成时的结果记录。包含第一台原机在内的六台当前参数、后续维护和验收进度，统一更新到[六台Ubuntu与搬瓦工中转：部署与维护手册](六台Ubuntu与搬瓦工中转-部署与维护手册.md)。

记录时间：2026-10-22，香港时区。

本次已完成 ubuntu-cc-03～06 的 CC 服务及搬瓦工中转部署。02 沿用此前交接中已经通过的部署；本次没有重新初始化02或修改原机8443配置。

## 入口与验收

| Ubuntu | 最近内网IP | 客户端连接地址 | VPS回环端口 | 状态 |
| --- | --- | --- | --- | --- |
| 02 | 172.28.152.159 | `wss://74.82.201.214:8444/ws` | 28788 | 此前交接已通过健康和证书核对 |
| 03 | 172.28.147.163 | `wss://74.82.201.214:8445/ws` | 28789 | 本次部署及公网证书核对通过 |
| 04 | 172.28.148.235 | `wss://74.82.201.214:8446/ws` | 28790 | 本次部署及公网证书核对通过 |
| 05 | 172.28.148.113 | `wss://74.82.201.214:8447/ws` | 28791 | 本次部署及公网证书核对通过 |
| 06 | 172.28.156.180 | `wss://74.82.201.214:8448/ws` | 28792 | 本次部署及公网证书核对通过 |

内网IP为Hyper-V Default Switch DHCP地址，重启后可能改变。

03～06均由用户在远端Windows的SSH终端完成Ubuntu操作，本聊天直接完成VPS配置。每台本机健康检查成功；常驻隧道启动后首次公网curl均出现一次SSL_ERROR_SYSCALL，自动重试后成功。本机随后逐台独立核对公网TLS证书SHA256并收到HTTP 200：`{"status":"ok","protocolVersion":19,"adapter":"claude-code"}`。

VPS各机转发服务均已确认active/enabled，公网入口和对应回环隧道均处于LISTEN。每台使用独立隧道公钥，仅授权对应回环端口；追加授权前已备份authorized_keys。UFW分别放行8445～8448/tcp。Ubuntu端隧道均执行enable --now，并配置断线自动重连。

## 客户端证书指纹

以下是CC服务证书SHA256，不是VPS SSH主机指纹。

| Ubuntu | SHA256 |
| --- | --- |
| 02 | `71:2C:ED:7A:C3:EE:9D:AB:AF:51:D2:2A:D6:F2:27:9F:54:39:BD:F3:4F:D6:33:16:61:CC:21:D6:A0:1F:E5:EE` |
| 03 | `C1:4A:43:68:C1:83:12:98:1F:1D:2D:51:1D:1D:6C:43:C3:CB:C7:4A:48:9A:C1:7E:E4:10:2F:00:D4:58:36:E8` |
| 04 | `2A:3A:37:45:E4:AB:E5:BB:A2:97:98:E2:63:6B:86:30:CB:81:5D:EB:05:75:98:DC:A2:71:B8:9A:8E:49:FA:A0` |
| 05 | `AE:77:2D:B9:D8:D0:F9:2C:25:36:24:76:D4:69:B5:93:E4:BE:97:29:8C:8E:B1:C1:4A:4E:55:74:D0:96:A1:FE` |
| 06 | `E1:B6:EC:47:78:C5:C3:8A:D9:1B:EC:24:D3:E2:E2:99:FB:FE:BC:C5:37:33:9A:B2:3E:22:FA:A4:53:1D:3B:04` |

在本地CC客户端为各台创建独立连接，填对应地址与指纹。服务凭据由用户在对应Ubuntu终端查看：

```bash
cd /opt/cc-desk-tunnel
sudo bash deploy/manage.sh connection
```

将PROXY_TOKEN的值填入该机客户端连接，不带变量名与外层引号。该命令会显示真实凭据，勿将完整输出回传聊天。

## 运维位置

- Ubuntu程序：`/opt/cc-desk-tunnel`；部署配置：`.local/docker.env`。
- Ubuntu持久数据：`/srv/cc-desk-tunnel`；HTTPS绑定：`127.0.0.1:8787`。
- Ubuntu常驻隧道：`/etc/systemd/system/cc-bwg-relay.service`。
- Ubuntu隧道密钥：`/home/benben/.ssh/cc-bwg-relay`；主机密钥文件：`/home/benben/.ssh/cc-bwg-known-hosts`。
- VPS服务：`ccdesk-relay-ubuntu-cc-03.service`至`ccdesk-relay-ubuntu-cc-06.service`。
- 链路：本地CC → 搬瓦工公网端口 → socat → VPS回环端口 → Ubuntu反向SSH → CC HTTPS。TLS在Ubuntu终止。

## 尚未验收

- 本地CC客户端连接、模型认证与实际回复、Windows执行通道。
- 各台Ubuntu实际重启后的服务恢复，以及Windows宿主机重启/断电恢复。
- 新机模型请求的实际公网出口；搬瓦工中转成功不证明模型出口正确。

按此前安排暂缓模型测试。原交接记录中的存储/数据完整性异常根因尚未解决；本次部署成功不构成硬件问题已修复的证明。若再出现校验或解压错误，保留报错定位。
