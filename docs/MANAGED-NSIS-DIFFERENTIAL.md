# 受管 NSIS 安装包差分更新

本实现采用已选定的成熟方案：固定 `electron-updater 6.8.10` 的 `GenericDifferentialDownloader`，保留 CC SPACE 的 v1 Ed25519 签名索引、独立 Build 选择、协议限制、窗口退出协调和原 NSIS 安装器。不使用整套默认 semver 自动更新器，不直接替换已安装程序文件。

## 用户行为

- 客户端「下载更新」自动优先差分，重建完整 EXE；失败或不适用时，走原完整下载/断点续传。取消不触发完整下载。
- 网页仍提供原完整 EXE 地址。没有新的设置开关或安装方式选项。
- 生产 Build 33 必须先完整升级一次获得新引擎；后续版本可以自动采用已验证缓存。用户无需手动保存旧安装包。
- 下载完成不自动安装。现有安装前断开连接、会话占用和多窗口检查保持；安装前重读当前索引，重新核对完整 SHA256/大小。
- 此方法继续使用 NSIS，不宣称提供额外的断电原子安装或独立启动恢复。失败可使用完整安装包修复，不能把差分下载测试当作断电恢复证明。

## 可信链

原 v1 索引决定当前可安装的 Build、协议与完整 EXE SHA256/大小，反重放逻辑不变。新增不可变 `<filename>.differential.json`，用现有受信 Ed25519 公钥及独立签名域 `CC-SPACE-NSIS-DIFFERENTIAL-V1` 验证，精确绑定安装包七元身份（build/appVersion/protocol/sourceCommit/filename/size/sha256）、SHA512 和 gzip JSON v2 blockmap 的 SHA256/大小。

描述文件最多16KiB；块表压缩体最多4MiB、解压最多16MiB，严格验证版本、文件名/偏移、块数/长度及总跨度。签名、块表、网络异常只允许回退到已由 v1 索引授权的完整包；v1 验签/协议选择失败不授权任何下载或安装。

差分引擎只收到确切的同源 HTTPS URL 和有界块表。适配层严格处理206、Content-Range、Content-Length、编码、重定向、响应短读/超读、停滞超时和活跃请求取消。SDK内部接口固定版本隔离，不能直接替换成未回归的新版本。

## 安装包缓存

每个 installationId 下独立保存 installer.exe、map.blockmap、descriptor.json，按 Build、完整SHA256和唯一目录名关联，由原子 baseline.json 指针选中。加载时重新验证签名、运行中客户端的嵌入身份、块表及安装包完整哈希，不信任可修改的文件名或本地JSON。

基线延迟到下一次下载前建立，避免启动时等网络。种子仅来自受管 ready.exe 或 NSIS自带 `%LOCALAPPDATA%/cc-desk-tunnel-updater/installer.exe`；NSIS缓存可能缺失或属于另一版本，只有字节和当前身份签名描述匹配才复制采用。复制后的独立缓存不受“清理原安装包”操作影响。

下载目标不是已安装基线：仅当前实际运行的确认身份可以提升缓存。未安装、取消或失败不会把新目标提前当作旧包。新指针只在三件文件完整同步后提升；旧缓存及中断副本在持有原更新锁时清理，仅删除保留命名空间中的已知文件，未知内容和链接不跟随、不递归清除。

差分临时文件与完整断点续传文件分离。差分失败或取消后删除差分半成品，绝不拿它的长度作为完整续传前缀。原SHA256再验通过后才提升为ready.exe；最终哈希期间取消也不会变成ready。

## 打包

桌面依赖精确固定6.8.10。`bundleDifferentialEngine` 只把必需引擎打为独立的 `electron/managed-differential-engine.cjs`，不加载整套AppUpdater，也不复制默认feed/provider组件。实际打包包含第三方许可证 `managed-differential-engine.LICENSE.md`。单独测试在拒绝所有第三方模块解析的进程中加载该bundle并完成SDK校验复制，避免借用开发机node_modules而漏包。

继续用原 `npm run package:windows`。它生成完整EXE和`.blockmap`；包内无需自研逐文件安装助手或数百MB块数据sidecar。`package.spec.ts` 匹配的打包验收还包含真实Electron HTTPS用例，使用临时TLS证书、公钥和独立profile，不装到日常目录、不调用模型。

## 发布顺序

`publish-managed-update.mjs` 新增可选 `--blockmap`、`--public-root`：默认块表位于完整包旁，默认公开目录为 `/srv/cc-update-service/public`。旧源码及撤回沿用原流程；新差分源码必须提供有效块表。

上传候选完整EXE后、激活通道之前，发布器验证干净源码/Build/版本/协议、当前候选签名、外部私钥、完整EXE SHA256/SHA512和有界块表，再独占准备不可变完整EXE、块表和签名描述。通道最后激活。准备失败不会切换现网，上传候选保留供管理员检查；旧安装包、其他通道和管理中心运行程序不覆盖。

可独立执行附加制品准备（输入是已经由原工具签名的 v1 candidate/index JSON）：

```sh
node scripts/publish-managed-differential.mjs \
  --source CLEAN_CHECKOUT \
  --index SIGNED_V1_JSON \
  --artifact SETUP_EXE \
  --blockmap SETUP_EXE.blockmap \
  --private-key EXTERNAL_KEY \
  --key-id managed-vps-2026-10-23 \
  --public-root /srv/cc-update-service/public
```

完整EXE字段来自已签名索引，发布工具计算SHA512/块表哈希，生成当前格式描述；不宣称独立复算每个Blake2块哈希。SDK重构和客户端最后完整SHA256验证仍是必须执行的完整性检查。签名描述不含v1 revision/有效期，绑定不可变发布身份；续期可幂等准备相同sidecar，不能改写已发布字节。网页无须改版，Claude服务端协议仍为24。

## 验证

```sh
node --test apps/desktop/test-main/managed-differential*.test.mjs
node --test apps/desktop/test-main/*.test.mjs apps/desktop/test-main/*.test.ts
npx playwright test managed-client-update-ui.spec.ts managed-updates.spec.ts terminal-width-reload.spec.ts
npx tsc --noEmit
npx prettier --check .
```

2026-11-08 最终验收：差分专项106/106，桌面主进程685通过、0失败、38既有条件跳过；相关UI50/50；tsc、全仓Prettier及1014文件仓库检查通过。真实Windows打包3/3（正常HTTPS差分、忽略Range完整回退、原EXE启动及组件回收）。请求close事件曾被误当成响应失败，新增回归先失败后通过；保留响应完整性、取消和停滞超时保护。独立复核确认无响应20秒退出、取消约22毫秒退出、响应中断立即拒绝。

候选为0.3.10 / Build34 / 协议24，来自干净源码 `c5a2c637c047d1f2d1e428109def9bbb44d117b0`，完整EXE258667120字节，SHA256 `53742e467804637513583ae2764afffc4b124e9373279b3acf630f98c65ffb06`。完整证据见[验收记录](evidence/managed-nsis-differential-2026-11-08.json)。真实打包测试验证的是网络下载/重构和程序启动，没有运行安装器覆盖日常安装，也没有实测断电恢复；真实旧/新大包的下载节省仍见选型研究，不能承诺每次相同。

此前选型报告中的自研Build34只是不可变测试数据，不作为本实现发布包。生产发布与本轮接入实现分开，未push main、未上传或激活线上Build33入口。发布时必须同时准备完整EXE、匹配块表与签名描述，再激活通道。
