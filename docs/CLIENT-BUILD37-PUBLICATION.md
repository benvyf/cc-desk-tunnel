# Windows Build 37：运行中的过程图片与全屏查看器

2026-11-17（香港时间），按用户授权以最新主分支生成安装包，替换线上下载页和客户端更新入口，并清理管理中心空间。Windows pilot 当前为 **0.3.10 / Build 37 / 协议 24**，发行源码为 `26aa4142ac34df491333bdb7e5581c0f9a2deb5b`。现有协议 24 服务端（线上 Linux pilot Build 27）无需因此升级。

[下载 Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/37/win32-x64/CC-Space-Setup-0.3.10-x64.exe)。大小 **258893528 字节**，SHA256：

```text
b39f6b7f0c6495654cb6ce18b220560773f6dcefc7e4cca4667b39346b41f7a4
```

## 本次变化

- 运行中，本轮最新的几张图片显示在“正在执行…”上方；展开的步骤和工具详情以一行缩略图显示，放不下的以“+N”计数。
- 点击任意缩略图打开全屏查看器：在本轮全部图片间翻页，底部胶片条按步骤分组，支持适应窗口、实际大小、缩放、拖动、复制图片和下载，运行中有新图时提示。
- 截图很多的会话在流式输出时不再重复重绘历史缩略图；生成缩略图时以原生方式解码图片数据。

## 构建

沿用 Build 36 的干净构建工作树和依赖（`package-lock.json` 与各 `package.json` 自 Build 36 起未变），切换到新分支 `release/client37`；便携 Node 24.22.2、Electron 44.10.1。登记提交把 Build 37 补入协议 24 的 Windows 历史。

## 发布验证

- 打包内建检查 3/3 通过。安装包内 2439 个文件与 win-unpacked 逐一一致（另 1 个名称含 uninstall 的文件被比对过滤，内容不受影响），`app.asar` SHA256 为 `4cac67b55b69d17c0305d7acbd94f78c2831441c04c6f9e15511f34b33eacfd6`。包内身份为 Build 37 / 0.3.10 / 协议 24 / pilot，固定公钥与更新源未变，图片查看器、实况图片行与复制图片通道均在包内。
- VPS 上核对上传文件摘要、bundle 克隆后的提交与内嵌 Build、公钥与签名身份一致后发布：pilot revision 64，发布器完成公开索引、公网下载大小与 SHA256、差分描述与块表、另一通道不变的核对。
- 删除已激活的候选记录（删除前确认仅此一条且为 Build 37，删除后公开索引字节不变）。真实 systemd 临时 `--force` 精确续期为 revision 65，有效期至 `2026-11-20T09:54:53.226Z`；临时覆盖已移除，普通检查返回 not-due，Windows 与 Linux 续期 timer 均 active。
- 本机以固定公钥验证实时索引；客户端差分合约验证描述与块表；首、中、尾三个 HTTPS Range 与本地安装包逐字节一致。
- 用安装包内的更新控制器读取实时已签名索引：Build 36 显示可下载 Build 37 并提供“下载更新”；Build 37 无更新；协议 23 的旧客户端只提供完整包入口。验证在隔离临时目录完成，未修改用户已安装客户端。
- 管理中心服务 PID 未变、未重启，Nginx 检查通过；Windows stable 与 Linux pilot 公开索引摘要与发布前一致。生产私钥与管理员令牌未离开 VPS。

VPS 受保护发布记录在 `/root/.cc-update-admin/release-build37/`，干净发行源码在 `/root/.cc-update-admin/source-build-37`，精确续期登记已指向新公开安装包。发布前配置备份为 `/var/backups/cc-update-service/client37-publication-20261117T095119Z`。

## 管理中心空间清理

根分区可用空间由 4.1G 增至 5.9G（使用率 77% → 67%）。清单与删除前的大小、安装包 SHA256 记录在 `/root/.cc-update-admin/cleanup-20261117/manifest.txt`。

- 公开下载目录删除 Build 34、35 的完整安装包，保留其块表与差分描述：客户端以本机已有安装包为差分基线，只向服务端取块表与描述，差分更新不受影响。保留 Build 36 完整包作回退，Build 37 为当前版本；Windows stable 通道为空，未引用任何旧包。
- 删除 `release-build35`、`release-build36` 中与公开目录重复的安装包副本；`release-build37` 保留一份。
- 删除旧的 Windows 发行源码克隆 `source-build-2` 至 `source-build-34`（保留 35–37）、Linux 服务端旧准备目录 `linux-build9` 与 `linux-build10` 至 `linux-build17-preparation`，以及 11 月 9 日前的若干评审与临时目录。删除前把其中能完整读取的 17 份 git 历史合成 `/root/.cc-update-admin/cleanup-20261117/archived-sources.bundle`（12 MB）。其余克隆缺少父提交，无法打包；其中 Build 2–7、9、22–34 的发布提交已核对仍在开发机仓库或 VPS 保留的发布 bundle 中。Build 8、18、20 没有找到发布证据，无法核对其源码克隆对应的提交。
- 未改动：服务端续期引用的 `linux-build18` 至 `linux-build27` 准备目录、全部服务端制品、配置备份、签名与访问材料，以及 sub2api 等其他服务。