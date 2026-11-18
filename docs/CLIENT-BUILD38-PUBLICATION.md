# Windows Build 38：跨协议过渡版

2026-11-18（香港时间），按用户授权从 `release/client38`（提交 `da67e814994e08140f48a80582d94b7ebe296411`）生成并发布。**0.3.10 / Build 38 / 协议 24，内嵌通道 stable。** 发布方式见[两通道发布说明](CLIENT-BRIDGE-RELEASE.md)。

[下载 Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/38/win32-x64/CC-Space-Setup-0.3.10-x64.exe)。大小 **258896852 字节**，SHA256：

```text
5a3cd015b8f07e36385efb80d1a9e09bd830ab88ed077f14e390f17f531a69dc
```

## 本次变化

- 工作空间升级到新协议后，客户端提示“需要更新客户端”时可一键在应用内下载、校验并安装配套的新版客户端；无法在应用内更新时仍可下载完整安装包（[强制规则第二节第 6a 条](UPDATE-RELEASE-RULES.md)）。
- 此版本起客户端读取 stable 通道；pilot 长期保留本版本，供尚未升级的旧客户端经同协议自动更新到达。

## 构建

沿用 Build 37 的干净构建工作树 `D:/cc-desk-tunnel-release36`，新分支 `release/client38` 基于 `feat/cross-protocol-bridge`（c02ae99e）。便携 Node 24.22.2、Electron 44.10.1；`npm ci` 后按以往做法手动执行 electron、koffi 与 ssh2 的安装脚本（ssh2 可选加密绑定在 node-gyp 加入 PATH 后编译成功）。打包内建检查 3/3 通过；包内身份为 Build 38 / 0.3.10 / 协议 24 / stable，固定公钥与更新源不变，跨协议更新代码在包内。

## 发布与验证

- VPS 上传后核对摘要；停 pilot 续期 timer；bundle 克隆为 `/root/.cc-update-admin/source-build-38`。
- **先 stable 后 pilot**：stable revision 3、pilot revision 66，均通过公开索引、公网下载大小与 SHA256、另一通道不变的核对；两条候选记录确认后删除，公开索引字节不变。
- 续期：部署新版 `renew-managed-index.mjs`（签名契约未变）；pilot 登记 `automation/config.json`、stable 登记 `automation-stable/config.json` 均指向 Build 38 与 `source-build-38`；安装并启用 `cc-update-renew-stable.timer`。各强制续期一次：pilot 66→67、stable 3→4，有效期至 2026-11-21，候选 0；普通运行均返回 not-due。
- 以包内更新控制器读取实时签名索引：Build 37（pilot）显示可下载 Build 38；Build 38（stable）无更新。
- 发布前配置备份：`/var/backups/cc-update-service/client38-publication-20261118T082705Z`；受保护发布记录：`/root/.cc-update-admin/release-build38/`。

## 空间清理

根分区可用 5.3G（上传后）→ 6.1G。清单与删除前大小、SHA256 记录在 `/root/.cc-update-admin/cleanup-20261118/manifest.txt`：

- 删除公开目录 Build 36 完整安装包，保留其块表与差分描述；Build 37 完整包保留作回退，Build 38 为当前。
- 删除 `release-build37`、`release-build38` 中与公开目录逐字节相同的安装包副本。
- 删除 `source-build-35`、`source-build-36`（对应 bundle 保留在各自 release 目录）；`source-build-37` 保留。
- 未改动服务端准备目录、Docker 镜像、签名与访问材料及其他服务。
