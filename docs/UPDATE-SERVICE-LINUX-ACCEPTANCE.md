# VPS 更新服务：Linux 隔离验收

日期：2026-10-23（Asia/Hong_Kong）。[交付 B](UPDATE-SERVICE.md) 已在现有 VPS 上完成真实 Linux、临时 systemd 服务和独立 Nginx 的隔离验收。此次没有上线生产更新入口，也没有接入 Windows 客户端。

## 验收对象

| 项目 | 实际值 |
| --- | --- |
| 源码提交 | `50d8e8e4c294eac7b4a557183ed6a00764119163`，已推送 `codex/vps-update-channel` |
| 运行归档 | `cc-update-service-50d8e8e.tar.gz`，23,336 字节、14 个白名单文件 |
| 归档 SHA256 | `4d42accff7fe0830f5322dba70721785b064b21c77ffba08e66d8cead7dcc11a` |
| Linux | x86_64，内核 `6.8.0-124-generic`，glibc 2.39 |
| Node | 官方 `v24.19.0` linux-x64，单独解压，不安装系统软件、不修改 PATH |
| Node 归档 SHA256 | `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647`，与官方 HTTPS SHASUMS256.txt 一致 |
| 验收脚本 | `scripts/verify-update-service-linux.mjs` |
| 脚本 SHA256 | `1503fc5fae9a5d5fb790b674cbf0a12d734c4af16b77f3404584e65ac8148d6b` |
| 最终执行 | 临时 unit `cc-update-acceptance-jlu4einj.service`，exit 0，约 1.8 秒 |

## 结果

- BUILD-INFO 所有运行源码 hash 匹配，解压后不执行 npm install 即可启动。
- 临时 systemd DynamicUser（非 root）、PrivateNetwork、PrivateTmp、只读程序与 runtime、单独可写 RuntimeDirectory 正常工作。独立网络无外部路由，仅使用回环端口；已有 GhostAPI、RouteKey、Nginx 配置、生产证书及 Docker socket 均禁止读取。
- 实际 Nginx location 模板通过 `nginx -t`。测试只替换后端端口及公开制品目录；HTTPS 使用临时 localhost 证书，客户端显式信任该证书，没有跳过证书验证。
- 管理网页 200 且包含 CSP；无令牌 401，正确令牌可读状态；错误 Origin 403，非法签名输入 400；尚未发布的通道为 404。
- 错误 hash 和截短上传均拒绝，完整 2 MiB fixture 才能发布。公开索引与签名文件逐字节一致，禁止缓存。
- 安装包完整 GET 与 fixture 一致；HEAD 长度正确且无正文；`Range: bytes=0-15` 返回 206、精确 Content-Range 和前 16 字节；超界返回 416；POST 下载路径返回 403。
- 数据库、候选、配置、目录列表 URL 不可下载。实际 Linux private 目录为 0700，public 目录为 0755，公开文件为 0644。
- 注入冲突制品使激活失败后，旧索引仍完整。第二个写入进程启动失败；SIGKILL 原进程后锁释放，重启清理中断文件，reserved build 可按原身份重试发布。
- 无需重传即可续期、将已知 build 推广到 stable、签署撤回；低 revision 和撤回后的低 build 仍拒绝。撤回保留历史不可变安装包。
- 捕获的 Node/Nginx 日志不包含管理员 token、Bearer 凭据、签名私钥或请求正文测试标记。

## 现有环境与清理

验收前后逐项比较：`/etc/nginx` 文件 hash、主 Nginx PID、7 个既有容器的 ID/启动时间/运行及健康状态、宿主监听地址集合均一致。两个既有网关的 `/health` 均保持 HTTP 200、`status=ok`。

临时 systemd unit 已自动回收，RuntimeDirectory 已消失，无本次 Node/Nginx 子进程残留。已下载脱敏证据后，精确删除本次 `/var/tmp/cc-update-acceptance-jlu4einj`；临时 Node、证书及测试配置一并移除。没有改 DNS、防火墙、现有站点配置、生产容器或六台 Ubuntu。

本地忽略目录 `.local/update-service-linux-evidence/` 保存 before/after/comparison JSON 和最终执行日志。测试中仅产生临时身份，没有生成生产管理员令牌或生产签名私钥。

## 复现方式与边界

准备一个全新的专用临时根目录，放入经过 hash 校验的 Node 24、解压的运行归档和验收脚本。下面的命令在 Linux root 运维终端执行；`/mnt` 仅作为临时 unit 的只读命名空间挂载目标，测试进程以 DynamicUser 运行：

```sh
test_root=/var/tmp/cc-update-acceptance-NEW
test_unit=cc-update-acceptance-new
systemd-run --unit="$test_unit" --wait --pipe --collect \
  -p Type=exec -p DynamicUser=yes -p PrivateNetwork=yes -p PrivateTmp=yes \
  -p PrivateDevices=yes -p ProtectSystem=strict -p ProtectHome=yes \
  -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes \
  -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes \
  -p CapabilityBoundingSet= -p UMask=0077 -p RuntimeMaxSec=180 \
  -p "RuntimeDirectory=$test_unit" -p RuntimeDirectoryMode=0700 \
  -p "BindReadOnlyPaths=$test_root:/mnt" \
  -p 'InaccessiblePaths=-/opt/sub2api -/opt/sub2api-relay -/opt/ghostapi-creative-build -/etc/nginx -/etc/letsencrypt -/run/docker.sock' \
  /usr/bin/env /mnt/runtime/bin/node /mnt/verify-update-service-linux.mjs \
  /mnt/package "/run/$test_unit"
```

`runtime/` 指向已校验的官方 Node 解压目录，`package/` 是运行归档解压目录。使用 `/usr/bin/env` 是为了让 Node 路径在隔离挂载建立后解析；直接将 `/mnt/runtime/bin/node` 交给 systemd-run 会在宿主路径检查阶段失败。旧服务实际路径变化时，应在预检后调整禁止读取路径。

本次 Nginx 与 Node 使用同一临时 UID，已验证 URL 隔离和文件 mode；生产 Nginx 独立用户的穿越/只读权限仍需上线时实测。真实断电不在本次测试范围，不能据此声称已验证电源故障下的存储硬件持久性。临时 unit 使用与部署模板相同的主要限制，但不等于已经安装、启用并验证该持久 unit 的开机生命周期。

下一阶段仍需确定生产签名公钥及离线私钥保管、管理员令牌保管方式，配置正式更新服务及现有 HTTPS 站点路由，再验证实际公网 TLS/下载及生产身份权限。Windows 客户端交付 C、首个引导包与协议 19→20 配套迁移仍未完成；现有客户端不会因此自动出现升级能力。
