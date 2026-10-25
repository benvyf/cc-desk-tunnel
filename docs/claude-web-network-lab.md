# Ubuntu 隔离画面联调

这一步只验证测试客户端到完整 CC 服务、再到独立合成 RFB 的显示和人手输入。蓝色 320×180 画面不是 Claude。两个容器在新建的 Docker internal 网络中，不挂载生产 `/data`、Docker socket、`/etc/claude-code` 或浏览器 `/config`。不连接已有浏览器，不改变生产配置或其强制审核；没有真实账号、原生 CLI 或模型调用。

本地源码准备和测试不能证明 Ubuntu 或远端客户端已通过联调。当前本机没有 Docker，真实容器启动仍待管理员执行。网页原始键鼠输入尚无等价审核覆盖，生产真实 Chat 继续被门禁阻止；通过本试验也不改变这一点。

## 准备与运行

在开发工作区运行 `node scripts/package-claude-web-lab.mjs`，产物为 `.local/cc-browser-network-lab.tar.gz`，含显式白名单的服务源码、测试 peer、启动器、说明和 SHA256 文件清单；不含依赖、配置、登录数据或预置凭据。依赖沿用 Ubuntu 上正在运行的 CC 镜像，仅按不可变镜像 ID读取，既不下载也不构建镜像。

将归档文件传到能直连 Ubuntu 的远端 Windows，例如 Downloads 目录。其 PowerShell 中执行：

```powershell
scp "$env:USERPROFILE\Downloads\cc-browser-network-lab.tar.gz" benben@172.22.248.220:~/
```

在 Ubuntu 普通管理员终端执行（勿使用 `sudo bash`）：

```bash
lab_dir=$(mktemp -d "$HOME/cc-browser-network-lab-XXXXXXXX")
tar -xzf "$HOME/cc-browser-network-lab.tar.gz" -C "$lab_dir"
bash "$lab_dir/scripts/start-claude-web-lab.sh"
```

启动器要求主机名 ubuntu-cc、普通管理员 uid1000、至少600MiB可用内存和512MiB可用磁盘；拒绝复用已有同名容器/网络以及被占用的18789端口。新的服务和画面分别限制384MiB和128MiB内存、0.5CPU、只读根文件系统、无额外 capability。所有可写服务数据均在容器 tmpfs 中；凭据及证书保存在新建的仅管理员可读 `.local/browser-lab-state-*` 目录。服务证书与凭据独立生成，不使用生产 token；请勿回传 `client-connection.txt` 内容。

`SYNTHETIC_RFB_DNS_AND_GREETING_OK` 验证试验网络内的 DNS/WebSocket/RFB 版本头；`LAB_READY` 表示 TLS 健康检查和此项探测均通过。只查询测试画面的版本头，不操作 Claude。若镜像 runtime 或依赖不兼容，启动器失败并只清理本次创建的容器和网络；保留本次私有证书文件以便管理员自行清理。不要因此重装生产服务或浏览器。

## Windows 客户端联调

远端 Windows 另开 PowerShell，建立专用于测试服务的 SSH 隧道，保持该窗口打开；已有16090查看器隧道可继续保留：

```powershell
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:18789:127.0.0.1:18789 benben@172.22.248.220
```

该地址只在运行上述 SSH 的 Windows 上可用。当前本地 Windows 若不能直连 Ubuntu，不可直接照用该地址；必须先确认管理路由，不能为此开放公网18789端口。管理员需回传客户端运行位置，再选择对应预览程序启动路径；当前发行的旧客户端可能还没有 Chat，不能以管理员 noVNC 网页代替客户端验收。

使用本分支的独立预览客户端及新的临时用户目录，不覆盖正式安装或用户配置。服务地址填 `wss://127.0.0.1:18789/ws`；凭据和高级连接选项中的 SHA256 服务证书指纹取自 Ubuntu 启动器打印路径里的 `client-connection.txt`，仅在自己的客户端输入，不回传。显式证书指纹验证继续生效，不关闭 TLS 校验或安装系统根证书。

用户已选择在运行 Codex 的本地 Windows 上验证。2026-10-25 本机到 `172.22.248.220:22` 的 TCP 连接3秒超时，本机IPv4位于192.168.1.0/24；这不能证明所有管理路线均不可用，但当前无直接SSH证据。代码中的 Coding SSH 服务设置 `AllowTcpForwarding no`，不修改该限制。需用户补充是否已有SSH跳板或私网VPN；目前只有远端Windows管理隧道已验证，不能据此宣称本机可用。当前不新增公网监听或外部中继。

本地开发工作区已准备 `scripts/open-browser-lab-preview.ps1`，通过独立 `.local/browser-lab-client-profile` 启动当前 Electron 前端，不加载正式用户配置，不自动连接任何服务。只有本地管理转发已就绪时才能填入上述回环地址；运行预览脚本本身不会建立SSH或VPN。示例（在开发工作区 PowerShell）：

```powershell
powershell.exe -NoProfile -File .\scripts\open-browser-lab-preview.ps1
```

连接后点击 Chat，再手动点击“连接远端网页”。应看到蓝色画面；点击并输入一个英文字母，切换 Coding 后返回，检查连接和画面仍可用。不要在此测试生产账号或粘贴真实内容。单元回归确认输入能到达合成 peer；手动查看蓝色画面本身不能证明输入已到达。现有真实 Electron 回归另覆盖像素读取、输入、切换释放、断线和拒绝本机网站旁路。

两个进程45分钟后退出，容器自动移除，临时数据消失，网络和主机私有文件保留；到期后应重新启动并重新核对连接信息。主动停止并移除试验网络：

```bash
sudo docker stop cc-browser-lab-service cc-browser-lab-frame
sudo docker network rm cc-browser-lab-net
```

这些固定名称仅由本次隔离联调使用。不要删除或停止名称不同的 CC、备份或真实浏览器容器。停止后客户端应显示断线，Coding原草稿/正式实例不受影响。用户回传不含凭据的启动状态及画面结果即可；未通过客户端完整往返前不能宣称远端链路验收完成。

本地验证：新增完整CC服务TLS/RFB回归及原门禁/受管启动共19项通过；启动器的4种Shell模拟场景通过（`bash scripts/test-claude-web-lab.sh`），Bash语法与类型检查通过；真实Chrome/Electron的3项Chat回归通过。Shell模拟不能代替实际Docker隔离验证，尚未在Ubuntu启动本试验。
