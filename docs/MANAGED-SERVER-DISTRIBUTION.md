# 配套 Linux 服务端发布与首次接入

Linux 索引独立于 Windows 更新数据库、候选和通道，固定地址见 [冻结协议](MANAGED-SERVER-CONTRACT.md)。管理中心“客户端更新”页同时提供完整 Linux 包、Build／协议／SHA256，以及第一台 `ubuntu-cc` 的“已接入服务端升级”和“首次接入”两种独立命令。未发布或签名过期时不生成命令，复制时也检查有效期。下载不会自动安装。

已完成首次接入的节点使用“复制已接入服务端升级命令”，整行粘贴到 Ubuntu 控制台执行。命令自动绑定当前签名发布的精确 Build、协议和归档 SHA256；使用容器已有 env-file 和业务用户，在容器 loopback 管理 API 检查目标、明确确认安装并等待就绪提交，每15秒打印进度。忙碌时拒绝，原有兼容性、冷备份、签名和失败回滚仍由监督程序执行；无需再次 bootstrap 或重新登录 Claude。只读相同版本识别也不启动 Claude。HTTPS 使用现有 healthcheck 的证书信任策略，不关闭证书校验。完整可读脚本为 `apps/update-service/web/server-upgrade.cjs`，页面命令是该脚本加精确目标的压缩单行版，命令中不含服务令牌。

`scripts/package-server.mjs` 只打包干净提交，重新构建配套 Web，生成完整 `SERVER-RELEASE.json`；文件采用 root／0644 的普通 USTAR 条目。包内无账号、环境配置、依赖、监控授权或私钥。`scripts/package-update-service.mjs` 包含 Linux 分发模块、共享严格文件校验器、管理页面、安装器、发布 CLI 和续期单元的完整运行依赖。

## VPS 管理员发布

使用 VPS 已有 Node 24；以下文件路径均为管理员本地文件。示例不生成或输出密钥。

```sh
node scripts/managed-server-publication.mjs sign \
  /etc/cc-update-service/config.json /private/server.tar.gz \
  /private/signing.pem managed-vps-2026-10-23 1 /private/server-index.json
node scripts/managed-server-publication.mjs publish \
  /etc/cc-update-service/config.json /private/server-index.json /private/server.tar.gz
```

签名前先验证完整归档、描述文件、依赖锁和兼容性摘要。发布时再次验证签名和完整归档；同 Build 的所有发布字段必须相同，已存在文件只能字节相同。Revision 和 Build 不得倒退。不可变归档与其最初签名元数据先落盘，再原子切换当前索引。发布树位于配置 `dataDir/server/`；目录 0755、公开文件 0644，可由现有非特权服务读取。其他数据树不改动。进程崩溃留下 `.publication-lock` 时保持拒绝写入；管理员确认没有发布进程、核对现有索引和文件后才可移除锁并重试。中断造成的残缺不可变文件必须人工核对处理，不能覆盖它们。

Nginx 模板新增精确 Linux 索引和归档路由，均只允许 GET／HEAD，且归档经服务端固定路径、普通文件及 SHA256 校验；未知路径返回 404。Windows 现有路由和配置保持原样。先备份运行目录、配置、单元、Nginx 和业务数据，再更新运行文件并执行 `nginx -t`、服务健康检查、公开 GET／HEAD 与哈希验证；失败回退运行文件，保留当前业务数据。此文档和测试不表示已部署。

## 独立签名续期

创建 root 私有的 `/root/.cc-update-admin/server-renewal.json`，只含 `serviceConfig`（现有服务配置绝对路径）、`keyFile`（Ed25519 私钥绝对路径）、`keyId` 和 `expectedRelease`（完整精确的已确认 Linux release 对象）。续期在剩余有效期不超过两天时签发 14 天的新索引，只增加 Revision 并更新时间；已注册 release 的任何字段变化都停止续期。支持 `renew CONFIG --force`；Windows 的 automation 配置完全独立。

审查后安装 `deploy/update-service/cc-server-index-renew.service` 和 `.timer`。该单元没有网络访问，只能写 Linux 发布目录。首次发布必须先创建该目录；不要把 Windows 的 expectedRelease 直接复制到 Linux 配置。签名密钥始终留在 root 私有目录。

## 第一台 Ubuntu

公开 `server-bootstrap.py` 是自包含 Python 标准库安装器，只接受已审查的主机、容器、源文件摘要、Node 24／x64、SDK 0.3.286 和官方 CLI 2.1.295 的确切二进制 SHA256。旧试点没有 CLI 安装戳；校验文件所有者、权限和二进制摘要即可，绝不执行 `claude --version`。未知入口、用户、目录、额外挂载、动态端口或缺少重启策略会在停服前拒绝。程序依赖、持久化实现不兼容时转人工镜像升级。原始镜像不必等于历史 base；宿主机旧 Compose 源码不参与。

页面命令使用 POSIX 单引号编码完整 Python 程序，固定 VPS 来源，拒绝重定向，限制安装器大小并校验其 SHA256，再把精确 Build／归档 SHA256 传给安装器。安装器从固定公开路径下载有时效的签名索引和归档，利用已有容器镜像中的 Node crypto 在无网络、无数据挂载的临时容器内验证 Ed25519，严格验证所有归档条目及完整 inventory。首次接入额外将持久化实现、Claude／legacy 序列化器及三个协议文件的原始字节 SHA256 固定到原节点已审查版本（协议 20）；候选包自己的签名兼容性声明不能绕过该检查。后续协议变化通过监督程序升级处理。没有安装 Node、CLI、SDK、系统依赖或从 GitHub 获取内容的步骤。

安装前先检查现有进程、源代码和只读审核策略，再用合成审核文件、CLI 哨兵和空 `/data` 做离线监督程序 readiness／health／SIGTERM 检查。测试进程使用完全独立的合成环境，不继承监控或服务令牌。停服前暂停进程后再次检查进程、活跃 TCP 及未完成 run；通过后断开网络并停止旧进程，保存完整冷 `/data`、实际可写层快照和完整 inspect。最终镜像从这个冷快照构建，覆盖完整程序、真正的 `/usr/local/bin/proxy-entrypoint` 和 `/opt/runtime/level`，保留原 runtime／node_modules，再重复无网络检查。替换容器复制原 Config、HostConfig、环境、挂载、网络；只改 Image。真实服务只做启动、本机认证状态及健康检查。

备份只在 Ubuntu 的 `/var/lib/cc-server-bootstrap/backup-*`，包含可能带凭据的 `original.json`，不会上传。该目录 root 私有。旧容器保留，替换失败时只移除确切的新容器并恢复旧容器、网络、名称和重启策略；不把旧数据覆盖回业务目录。安装器输出可离线执行的 `sudo python3 BACKUP/rollback.py --rollback BACKUP`，其 helper 全部内嵌，无需 VPS 或临时下载文件。安装标记支持安全重试；容器已改变则要求人工检查。

没有第一台 Ubuntu 的 SSH 授权入口时，只交付已校验的控制台命令，不能声称已执行。验证禁止真实账号／额度／Claude／JEV 调用和原生终端启动。Python 单元测试命令为 `python3 apps/update-service/test/server-bootstrap.test.py`，网络隔离的 Docker 监督程序检查与生产首次执行仍需分别记录证据。
