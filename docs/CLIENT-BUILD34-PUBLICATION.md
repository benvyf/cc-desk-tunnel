# Windows Build 34：成熟 NSIS 分块差分更新

2026-11-08（香港时间），按用户授权推送主分支并发布 Windows pilot **0.3.10 / Build 34 / 协议 24**，替换管理中心原 Build 33 下载入口。发行客户端源码为 `c5a2c637c047d1f2d1e428109def9bbb44d117b0`；后续主分支提交补齐发布权限、Nginx 示例及本次发布记录，没有改动候选客户端运行字节。

[下载 Windows 完整安装包](https://api.ghostapi.org/cc-updates/v1/artifacts/34/win32-x64/CC-Space-Setup-0.3.10-x64.exe)。大小 **258667120 字节**，SHA256：

```text
53742e467804637513583ae2764afffc4b124e9373279b3acf630f98c65ffb06
```

客户端「下载更新」优先采用固定 electron-updater6.8.10 引擎重构完整 NSIS 安装包；异常或不适用时完整回退，取消不回退。保留原签名索引、独立 Build 判断、协议限制及安装前检查；网页始终提供完整 EXE。Build33 及更早版本需完整升级一次，之后客户端自动验证并维护旧包/块表/签名描述缓存。清理原下载文件通常不影响安装器缓存；所有有效基线丢失时完整回退，不能仅依靠已安装程序文件差分。详见[实现说明](MANAGED-NSIS-DIFFERENTIAL.md)。

## 上线验证

- 候选客户端验证：差分专项106/106、主进程685通过/0失败/38既有条件跳过、UI50/50、真实Windows打包3/3；类型、格式和仓库检查通过。安装包内 app.asar 与已测 win-unpacked 逐字节相同，SHA256 为 `8ffaa07e2433bad7ae32114f2da667890393ee22f5608581025419b1a0a36ae0`。安装器未覆盖日常客户端目录，不宣称断电恢复实测。
- 首次发布在激活前被原服务 chmod 权限检查拦住，Build33保持在线。确认原因是 root 签名发布器预建目录与原服务所有者不同；新增 Unix root/服务账号边界测试先失败后通过，按现有 public 根目录继承服务所有者并明确目录755/文件644，未绕过原激活检查。VPS发布测试28/28；Windows发布/流水线35通过/0失败/1 Unix root 条件跳过。最终全差分专项106通过/0失败/1平台条件跳过。
- Nginx 仅扩展原 Windows 完整包路径，允许 `.exe.blockmap` 和 `.exe.differential.json`；保留单 Range、禁止符号链接、禁止目录浏览及不可变缓存规则。`nginx -t`通过后reload。激活前验证公开sidecar签名/内容，激活后完整公网下载的大小和SHA256通过；开发电脑独立验证固定公钥签名、块表及首/中/尾三个HTTPS Range实际字节。
- Windows pilot 初次 revision51，真实 systemd 强制精确续期后 revision52，有效期至 `2026-11-11T11:21:56.572Z`；Build和完整制品身份不变。续期登记使用固定干净源码 `/root/.cc-update-admin/source-build-34` 和当前公开Build34包。临时force覆盖已移除，常规服务返回not-due，Windows/Linux两个timer均active。
- 发布器进一步保证已有正确所有者/权限的文件不会重复chown/chmod；新增ctime不变回归先失败后通过，并在真实systemd `ProtectSystem=strict` / `ProtectHome=read-only` 临时单元验证完整差分准备幂等成功，避免未来续期引入额外写权限。临时验证单元已自动回收。
- Windows stable与Linux pilot索引SHA256保持不变，未创建服务端安装任务；管理中心运行inventory逐项未变，服务未重启，生产签名私钥与管理员令牌未离开VPS。候选清理后为0。

## 已清理的安装包

在确认当前通道、候选和续期登记仅引用Build34后，删除下列四份普通文件，每份均先检查真实路径、文件类型、大小及完整SHA256，无递归删除：

- 公开 Build32 完整EXE：258611536字节。
- 公开 Build33 完整EXE：258618440字节。
- `/root/.cc-update-admin/release-build33/` 中重复上传的Build33完整EXE：258618440字节。
- `/root/.cc-update-admin/release-build34/` 中已完成发布的重复上传EXE：258667120字节。

合计 **1034515536字节（约1.03GB / 0.96GiB）**。已删除的Build32/33历史下载URL不再提供安装包；不会影响从旧客户端获取当前Build34完整包。保留当前Build34公开EXE及匹配块表/签名描述，这是后续差分基线所需内容；保留签名身份、源码、审计记录、数据库备份、Linux包及无关系统备份。清理后再次完整验证Build34公开文件和公网Range。

VPS受保护记录：`/root/.cc-update-admin/release-build34/`。发布前配置备份：`/var/backups/cc-update-service/client34-publication-20261108T111710Z`。包没有新增Authenticode签名；更新信任仍沿用既有Ed25519身份。

[结构化证据](evidence/windows-build34-production-2026-11-08.json)。
