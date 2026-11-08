# Windows Build 35：文件引用、表格预览与源码着色

2026-11-09（香港时间），按用户授权生成最新主分支安装包并替换线上下载页和客户端更新入口。Windows pilot 当前为 **0.3.10 / Build 35 / 协议 24**，发行源码为 `cd485b8086ba0fecd6b4ce0372b7c1c0773a077b`。现有协议 24 服务端无需因此升级。

[下载 Windows x64 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/35/win32-x64/CC-Space-Setup-0.3.10-x64.exe)。大小 **258907291 字节**，SHA256：

```text
5da10a8017027a6362d73d469ef7f80eea7f449623520f4d8a87e0e2a4a37905
```

## 本次变化

- 回答中新生成的文件名称可点击在右侧预览，覆盖中文、特殊字符、相对路径及明确目录下的命令产物；有歧义的文件名不误打开。
- XLS/XLSX/CSV/TSV 只读表格预览，支持工作表切换、行列标题和大表滚动；保留真实空行、空字段和格式化保存值，不执行公式或还原图表、完整 Excel 排版。
- 常见语言及 PowerShell 源码语法着色，保留原文复制、行列定位和多窗格行为。

## 发布验证

- 使用干净主分支源码、固定依赖与 Electron 44.10.1 构建。实际 Windows EXE 离线启动、组件退出和成熟差分 HTTPS 检查 3/3 通过。安装包中解出的 app.asar 与已测 win-unpacked 完全一致，SHA256 为 `05296716f07a9f26082f0104a26d8c4ca2ab0747ef4c23afeed90d2eedade908`，包内身份及新增 Worker/源码着色资源核对通过。
- 首次激活 pilot revision 53。真实 systemd 强制精确续期后为 revision 54，有效期至 `2026-11-11T18:46:16.722Z`；Build、安装包及发布身份保持不变。临时 force 覆盖已移除，普通检查返回 not-due；Windows 与 Linux 续期 timer 均 active，候选为 0。
- 发布器及真实续期分别完成公网完整安装包下载的大小和 SHA256 校验。本机另用固定公钥验证实时索引、差分描述及块表，并比较首、中、尾三个 HTTPS Range 的实际字节。
- 将真实公网已签名索引交给随包更新控制器，再将其状态交给实际更新界面：协议 24 的 Build 34 提供可点击的“下载更新”，Build 35 显示当前无更新，旧协议保留新版本元数据并只提供完整包入口。验证在隔离测试配置中完成，未修改用户已安装客户端或运行安装器。
- 管理中心的 74 项运行文件 inventory、服务 PID 和 Nginx 配置保持不变；Nginx 检查通过，管理服务未重启。Windows stable、Linux pilot 的公开索引摘要保持原值，未创建服务端安装任务。生产私钥与管理员令牌未离开 VPS。

线上入口已从 Build 34 切换到 Build 35；保留 Build 34 的不可变完整包及匹配块表/描述，供现有成熟差分基线与回退核验使用，不原位覆盖旧制品。

当前发布 VPS 为 `212.50.248.138`，已沿用本机既有 SSH 主机校验与授权密钥核实；旧文档的 `74.82.201.214` 属于迁移前记录。VPS 受保护发布记录在 `/root/.cc-update-admin/release-build35/`，干净发行源码在 `/root/.cc-update-admin/source-build-35`。精确续期登记指向新公开安装包。发布前配置备份为 `/var/backups/cc-update-service/client35-publication-20261108T184345Z`。

[结构化验证证据](evidence/windows-build35-production-2026-11-09.json)。
