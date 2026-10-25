# Ubuntu 网页联调：只读预检

> 2026-10-25 用户已改选[本地内嵌网页与 Ubuntu 出口](superpowers/specs/2026-10-25-local-browser-remote-egress-design.md)。下文保留已完成的管理员查看器预检记录；原合成画面联调暂停，无需传输旧测试包。

下一步先收集当前 `ubuntu-cc` 的实际状态，不启用真实网页通道，不重启浏览器或 CC，不改 Docker 网络，不读取 profile 或访问 Claude。现有本地测试不能代替此步骤。

在已打开的 Ubuntu 管理员终端运行 [check-claude-web-ubuntu.sh](../scripts/check-claude-web-ubuntu.sh)。可以把文件完整内容直接复制到 Ubuntu 的 Bash 终端执行；外层子 shell 避免修改当前终端的 shell 设置。脚本需要 `sudo` 的 Docker 读取权限和 Ubuntu 自带的 Python 3。不要重新运行试验浏览器的安装脚本。

报告包含内存、根分区、管理端口、匹配的 CC/浏览器容器状态、网络名称、端口映射、容器内挂载目标，以及配置是否声明的布尔值。不会输出环境变量值、主机挂载源、浏览器启动参数或 Cookie；不保存完整 Docker inspect 结果。

注意两个限制：Docker 的声明环境变量并不反映受管镜像启动时强制注入的审核配置；网络名称相同也不证明容器 DNS 或 WebSocket 可达。因此输出中没有审核环境变量不能作为移除门禁的依据。

获得输出后，先核对浏览器端口是否仍只绑定回环、现有浏览器是否运行、磁盘/内存是否足以支持隔离联调，以及服务网络是否分离。再确定使用独立合成 RFB 服务的最小网络试验配置。没有解决网页输入的强制审核覆盖前，不把已登录浏览器接到生产 Chat。

当前本地工作区不能直接访问此前由远端 Windows 承载的 Ubuntu 终端；真实预检需在该终端执行并回传输出。脚本只是在本地准备，不能据此声称 Ubuntu 已检查。

本地验证：脚本 Bash 语法通过；模拟 Docker 输出验证命令只含 ps/inspect/stats，环境变量值、主机挂载源及错误中的私有文本不出现在报告中；完整服务浏览器门禁及受管启动共 18 项测试通过，TypeScript 通过。未对该机器部署或修改配置。

## 2026-10-25 用户回传结果

用户回传了容器部分的预检输出：`cc-claude-web-trial` 已停止，位于默认 `bridge` 网络，端口配置仍为 `127.0.0.1:6090 -> 6080/tcp`，保留 `/config` 挂载；仅凭挂载目标不能验证 profile 内容或登录状态。CC 主容器 `cc-desk-tunnel-ba938975-proxy-1` 正在运行且健康，位于 `cc-desk-tunnel-ba938975_default` 网络，保留只读 `/etc/claude-code` 挂载；即时内存为 217.5MiB，CPU 为 8.03%。两个停止的备份容器带有历史 `unhealthy` 状态，不能据此认定运行中的主服务异常。

两者当前没有共同的已声明 Docker 网络，不能直接据示例启用容器名上游。声明环境变量为 false 仍不能证明受管审核关闭。此次回传未包含主机内存、磁盘和实际监听结果，也没有浏览器退出码、OOM 标志及退出时间，因此先补充这些只读数据；不猜测退出原因，不重建或清理容器，不重跑安装脚本。

在 Ubuntu Bash 终端执行以下检查并回传输出（不会启动浏览器或访问 Claude）：

```bash
sudo docker container inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} restart={{.HostConfig.RestartPolicy.Name}}' cc-claude-web-trial
free -m
df -h /
ss -lnt '( sport = :5900 or sport = :6080 or sport = :6090 or sport = :9222 )'
```

`OOMKilled=false` 不能排除所有宿主内存问题；退出码和时间也只能用于缩小原因范围。补充证据后再决定是否恢复管理员查看器以及准备隔离合成 RFB 网络联调。

### 补充结果及恢复管理员查看器

用户随后回传：浏览器退出码为 0、OOMKilled=false、restart=no，运行时间为 2026-10-25 10:31:29Z 至 13:02:34Z（香港时间 18:31 至 21:02）。没有记录到非零退出或容器 OOM，但仍不能确定停止由谁触发。主机 MemAvailable 为 1416MiB、swap 已用 196MiB，根分区剩余 3.3GiB；5900/6080/6090/9222 没有监听。

下一步仅启动已有 `cc-claude-web-trial`，沿用现有配置和 `/config` 挂载，不重建镜像、不改网络、不配置 CC 上游。启动后 Chrome 可能恢复原标签页并从 Ubuntu 发出网页请求。这是管理员人工检查登录保留情况，不代表已通过客户端联调或审核准入。

```bash
sudo docker start cc-claude-web-trial
(
  for attempt in {1..15}; do
    if curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:6090/vnc.html -o /dev/null 2>/dev/null; then
      echo 'VIEWER_READY: http://127.0.0.1:16090/vnc.html?autoconnect=1&resize=scale (Windows SSH tunnel required)'
      exit 0
    fi
    sleep 1
  done
  echo 'VIEWER_NOT_READY: return the container status below; do not reinstall.'
)
sudo docker container inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' cc-claude-web-trial
sudo docker stats --no-stream --format '{{.Name}} | {{.MemUsage}} | CPU={{.CPUPerc}}' cc-claude-web-trial
```

就绪后，经此前远端 Windows 上的 SSH 隧道人工打开查看器，检查是否仍已登录；不为测试自动发消息或刷新官网。无需回传含账号或聊天内容的截图，只需回传就绪/状态输出及“仍已登录／要求重新登录／画面异常”。恢复命令尚待用户在 Ubuntu 执行，不能据此声称容器已经恢复。审核覆盖仍未解决，不把真实浏览器接到生产 CC。

### 查看器恢复结果

用户随后回传 `VIEWER_READY`、容器 running、退出状态0、OOMKilled=false，瞬时内存126.8MiB/900MiB、CPU0.53%；不能用启动早期读数代替稳定运行占用。用户重新在远端 Windows 建立16090 SSH转发后，确认可进入Claude页面。管理员查看器恢复已获用户反馈，客户端画面链路尚未实际验收。

接下来按[隔离画面联调说明](claude-web-network-lab.md)准备独立合成画面，不连接已登录浏览器，不改变生产审核。中文输入适配按用户要求暂不启用。
