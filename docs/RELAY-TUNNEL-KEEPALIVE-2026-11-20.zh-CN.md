# 中转隧道断线排查与保活（2026-11-20）

本文记录 2026-11-20 对客户端两种断线提示的排查结论、已在中转机上做的修改，以及服务端（Ubuntu）一侧尚未完成的建议改动。时间均为 UTC，括号内为北京时间。

## 1. 当前链路

```text
Windows 客户端
  → 中转 VPS 189.105.70.247:8443（socat，systemd 单元 ccdesk-vmiss-8443.service）
  → 中转机 127.0.0.1:28787（sshd 远程转发监听）
  → 反向 SSH 隧道（由服务端 115.132.87.43 以用户 ccdesk-relay 发起）
  → 服务端 127.0.0.1:8787（CC HTTPS / WebSocket 服务）
```

- 2026-11-20 起，第一台的公网入口是 `wss://189.105.70.247:8443/ws`。其余 8444～8448 的 socat 单元同样存在，对应回环端口 28788～28792，排查当天只有 28787 有隧道监听。
- `docs/bandwagon-relay-setup.zh-CN.md`、`docs/六台Ubuntu与搬瓦工中转-部署与维护手册.md` 中的 `74.82.201.214`，以及发布文档中的 `212.50.248.138`，都是迁移前的记录。命令和配置结构仍可参考，地址以本文为准。
- 客户端与服务端之间是端到端 TLS，证书指纹固定。中转机只做 TCP 转发，看不到也改不了通信内容。

## 2. 现象与结论

客户端出现的两种提示：

1. “已有 45 秒没有收到服务端的任何数据，连接已经断开……”
   - 来源：`apps/desktop/electron/proxy-bridge.mjs` 的心跳。每 15 秒发一次 ping，静默超过 2.5 个周期就放弃。
2. “与 189.105.70.247:8443 的连接被中断……”
   - 来源：`apps/desktop/electron/connect-errors.mjs`，对应 ECONNRESET。
   - 这句提示已在本次修改中改写，见第 4 节。

中转机日志对出来的时间线：

| 时间 | 中转机 | 客户端 |
| --- | --- | --- |
| 约 06:08:20（14:08:20） | 隧道开始不通，两端都还没察觉 | 开始收不到数据 |
| 06:09:07 | 隧道会话仍然在 | 45 秒无数据，判定断线 |
| 06:09:37 | sshd 才关闭从 03:36 起的隧道会话 | 重连被重置 |
| 06:09:40 | socat 连 127.0.0.1:28787 被拒绝（监听已没了） | 重连失败 |
| 06:09:43 | 服务端重新建好隧道 | 06:09:44 连回 |
| 06:29:33～06:30:20 | 旧隧道卡住约 50 秒后才关闭，06:30:24 重建 | 1006 断开，5 次重连都被重置，06:30:32 连回 |

结论：

- 断线是服务端到中转机之间的反向 SSH 隧道卡住了，是两台服务器之间跨境线路的问题，不是客户端到中转这一段。
- 每次中断要 50～75 秒，原因有三：
  - 中转机 sshd 没开 `ClientAliveInterval`，自己发现不了隧道已经死了；
  - 只能等服务端那头 `ServerAliveInterval=15 × 3` 超时，再加 `RestartSec=5` 才重建；
  - 在这段时间里，中转机上旧的 28787 监听还在，socat 照样接收新连接，再转进死隧道，所以客户端连续收到 ECONNRESET。
- 2026-11-19 经过旧地址 212.50.248.138 时出现过同样的模式。
- 另外，07:00 前后客户端那两次 1006 断开，是有人手动重启 socat 单元和 sshd 造成的，与线路无关。

## 3. 已完成：中转机 sshd 保活（2026-11-20 07:3x UTC）

文件 `/etc/ssh/sshd_config.d/10-ccdesk-relay.conf`，在 `Match User ccdesk-relay` 块内追加了两行：

```text
Match User ccdesk-relay
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    ClientAliveInterval 5
    ClientAliveCountMax 3
Match all
```

- 改之前的备份在 `/root/10-ccdesk-relay.conf.bak-20261120`。
- 执行了 `sshd -t` 和 `systemctl reload ssh`。`sshd -T -C user=ccdesk-relay,...` 显示 `clientaliveinterval 5`；root 等其他用户仍是 0，不受影响。
- `TCPKeepAlive` 不能写在 Match 块里，否则 `sshd -t` 会报错。全局默认已经是 `yes`，不用另外写。
- 效果：隧道卡住后，中转机大约 15～20 秒就会关闭死会话并释放 28787。服务端随后收到 RST，由 systemd 重启隧道。
- 只对新建的隧道会话生效。当时在用的会话不受影响，要等它下次自然重连才会用上新设置。如果想立刻生效，可以执行 `pkill -u ccdesk-relay sshd`，代价是所有隧道断开约 6 秒。
- 风险：线路丢包较多时，可能把很慢但还活着的隧道误判为断开，造成约 10 秒的短暂中断。真出现了，把 `ClientAliveCountMax` 改成 4。
- 回退：

```sh
cp -p /root/10-ccdesk-relay.conf.bak-20261120 /etc/ssh/sshd_config.d/10-ccdesk-relay.conf
sshd -t && systemctl reload ssh
```

## 4. 已完成：客户端（分支 fix/relay-reconnect，未打包）

- `apps/desktop/electron/connect-errors.mjs`：ECONNRESET / EPIPE / socket hang up 的提示改为“连接刚建立就被切断”。
  - 并说明：之前能正常连接的，多半是中转或服务端暂时没有应答，客户端会自动重连；第一次连接就出现时，才需要核对地址和端口。
- `apps/desktop/src/client.ts`：新增 `retryDelay()`。
  - 断线后的第一分钟内，重试间隔最多 3 秒（1、2、3、3……秒）。
  - 一分钟后恢复原来的上限：经桥接的连接 10 秒，其他 5 秒。
  - 隧道通常在一分钟内恢复，这样能更快接上。
- 不涉及协议改动，与旧服务端兼容。

## 5. 已完成：服务端隧道单元（2026-11-20 08:15 UTC）

用户在 `ubuntu-cc` 上执行了脚本：先备份为 `<unit>.bak-20261120`，再修改所有连向 `ccdesk-relay@` 的单元，然后重启。第一台实际有两个隧道单元：

- `cc-vmiss-relay.service`：连当前中转 `189.105.70.247`，known_hosts 是 `/etc/ccdesk-vmiss/known_hosts`。
- `cc-bwg-relay.service`：连旧中转 `212.50.248.138`（`HostKeyAlias=74.82.201.214`）。用户确认旧 VPS 已不用，2026-11-20 已执行 `systemctl disable --now` 停用，状态为 inactive / disabled。单元文件保留，需要时用 `sudo systemctl enable --now cc-bwg-relay.service` 恢复。

两个单元都已改为 `ConnectTimeout=5`、`TCPKeepAlive=yes`、`ServerAliveInterval=5`、`ServerAliveCountMax=3`、`RestartSec=1`，重启后都是 active。

中转机日志里，旧会话在 08:15:57 关闭，新会话同一秒就建立了。新会话是在第 3 节的中转机保活生效之后建立的，所以两端的快速检测现在都已生效。

回退方法：

```bash
for b in /etc/systemd/system/*.service.bak-20261120; do sudo cp -p "$b" "${b%.bak-20261120}"; done
sudo systemctl daemon-reload
```

然后重启这两个单元。

02～06 目前没有隧道接到 189.105.70.247；如果以后接入，也照下面的参数改。参数参考：

```ini
ExecStart=/usr/bin/ssh -NT ... -o ExitOnForwardFailure=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o ConnectTimeout=5 -o TCPKeepAlive=yes -R 127.0.0.1:28787:127.0.0.1:8787 ccdesk-relay@189.105.70.247
Restart=always
RestartSec=1
```

- 与第 3 节一起生效后，每次卡住预计稳定在 17～22 秒内恢复。
- 不需要 autossh：systemd 加 `ExitOnForwardFailure` 已经是正确的做法。
- 修改前先 `systemctl cat` 读出现有单元，只改上面这几个参数，不要套用其他机器的模板。改完执行 `systemctl daemon-reload && systemctl restart <单元>`，隧道会断开几秒。

## 6. 暂不采用的方案

- **两条隧道互为备份**：两条走同一段跨境线路，会一起卡；而且旧监听照样会接收 TCP，必须做 TLS 层的健康检查才有用。
- **WireGuard / QUIC**：需要改服务端，跨境 UDP 常被限速，维护成本更高。
- **客户端配置第二个中转入口**：这是唯一能真正绕开线路问题的办法，但需要第二台 VPS 并改客户端地址列表，留作以后再做。

## 7. 复查方法（中转机 root）

```sh
journalctl --since "-1 day" --no-pager | grep -E "ccdesk-relay|socat" | grep -E "Accepted|session closed|refused|reset|Broken pipe"
sshd -T -C user=ccdesk-relay,host=x,addr=115.132.87.43 | grep -i clientalive
ss -ltnp | grep 2878
```

判断方法：

- 隧道会话的 `session closed` 和下一次 `Accepted` 之间应只隔几秒。
- 从客户端最后收到数据到会话关闭，应在 20 秒左右。如果仍是 50 秒以上，说明当前会话还是保活生效前建立的，或者服务端那头还没改。
