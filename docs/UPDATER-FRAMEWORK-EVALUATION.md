# CC SPACE 成熟增量更新方案选型与隔离原型

2026-11-08，香港时间。研究基线 `origin/main 9f52c92`（已发布 Windows Build 33）。本分支 `codex/nsis-updater-evaluation` 只包含研究脚本、决策与证据；没有修改客户端运行代码、主项目依赖或 VPS。

## 选定的方法

对当前 CC SPACE，优先采用：**保留现有 Ed25519 签名索引、独立 Build 选择、窗口协调和 NSIS 安装流程；通过独立适配层调用固定版本的成熟安装包差分重构引擎。**

新旧 `.blockmap` 比较后，从客户端自动保留的旧安装包复制未变化的数据，只通过 HTTPS Range 下载缺失部分，组装出完整的新 EXE。先验证成熟引擎的 SHA512，再独立验证现有签名索引的完整大小和 SHA256，通过后继续原 NSIS 安装。网页仍下载同一个完整 EXE。

这采用的是受管缓存中的旧安装包，不是读取已安装文件进行逐文件替换。用户不需要手动保留 EXE，但客户端需要维护约一个完整包大小的基线缓存；更新期间还需目标包和安装器空间。现有 Build 33 仍需先完整升级一次获得新适配器；后续安装可自动补齐、验证基线缓存。缓存缺失、被清理、损坏或格式不兼容均全量回退，用户取消不回退。

## 为什么不直接整套替换

| 选择 | 已核对的能力或接入影响 | 本轮结论 |
| --- | --- | --- |
| 成熟差分引擎 + 现有受管更新器 + NSIS | 保留 Build、信任、安装路径和卸载身份；只改下载/缓存和附加元数据；真实重构已通过 | 近期优先 |
| 直接使用整套 NsisUpdater | 6.8.10 默认检测用 semver.eq，33/34 都是0.3.10会被视为无更新；`+build.33` / `+build.34` 也不参与排序；feed、缓存和安装时机还需重适配 | 不直接接管整套 |
| Velopack | 独立 Update.exe 和稳定启动 stub；安装结构迁移到 current，增加原生 Node 绑定及 vpk 打包链，快捷方式/卸载/实例账本需迁移；目录锁定处理可能终止占用进程，仍需 CC 活动协调 | 独立安装体系迁移再评估 |
| MSIX + App Installer | Windows 根据已安装包的64KB块复用；需要新包身份、证书、目录/注册表兼容验证，现有 EXE 发布合约也需迁移 | 系统级长期选项，不是近期最小改造 |
| 前一轮自研逐文件替换 | 已验证省流量，但新增安装事务维护、复杂故障恢复；候选实测准备约28秒、PowerShell校验替换约97秒，另需约360MB数据sidecar | 保留试验，不发布该候选 |

这里的“优先”是基于 CC SPACE 当前约束，不能外推为任何应用都应选同一种框架。成熟下载引擎不会自动赋予 NSIS 事务式或断电安全安装；如果目标升级为独立启动恢复体系，需要另外验证 Velopack/MSIX，而不是承诺换库就解决所有失败。

## 实际版本与来源

原型固定 `electron-updater 6.8.10`，直接调用其 `GenericDifferentialDownloader`，没有重写下载规划和复制算法；项目打包器是实际锁定的 `electron-builder/app-builder-lib 26.15.3`。该类位于内部模块，不是稳定公共API，生产接入必须放在小适配层后固定版本，并对每次升级做集成回归。没有把 v27 预发布文档里的功能当成本项目现成能力。

- [electron-builder v26 自动更新](https://www.electron.build/v26/docs/features/auto-update/)及[NSIS 配置](https://www.electron.build/v26/docs/nsis/)。
- [6.8.10 GenericDifferentialDownloader 源码](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.10/packages/electron-updater/src/differentialDownloader/GenericDifferentialDownloader.ts)。本机对应NPM源码也已检查：默认 AppUpdater 在同semver时直接返回false。
- [Velopack Windows 布局/更新](https://docs.velopack.io/packaging/operating-systems/windows)、[Electron 接入](https://docs.velopack.io/getting-started/javascript)和[差分包机制](https://docs.velopack.io/packaging/deltas)。
- [微软 MSIX 差分更新](https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-update)。

## 原型结果

使用上一轮两个真实候选安装包作为不可变测试数据，局部生成旧 blockmap、使用实际新 blockmap，临时 Ed25519 密钥和本地 HTTPS 服务。**这些 EXE 仍是上一轮自研更新器的候选包，只用来验证字节重构；不能把重构产物当成已接入成熟方法的新客户端发布。**

| 项目 | 数值 |
| --- | ---: |
| 完整目标安装包 | 258,643,238 字节 |
| 从旧安装包复制 | 256,215,446 字节 |
| 7个Range下载 | 2,427,792 字节 |
| 新 blockmap 下载 | 269,826 字节 |
| 下载体合计 | 2,697,618 字节（约2.70MB） |
| 相比完整包节省 | 98.96% |
| 本地HTTPS校验/下载/重构阶段 | 约1.8秒 |

原型没有执行 NSIS 安装器；约1.8秒不包含实际安装、公网链路耗时、用户交互，也不保证每次更新都有相同节省。结果比上一轮文件块方案多下载约0.8MB，但仅需原有完整包和小blockmap，不增加约360MB文件块数据，也不新增逐文件安装替换流程。

6个隔离场景全部通过：真实安装包重构且SHA512/SHA256匹配；坏缓存自动完整回退；服务器忽略Range时拦截后完整回退；停滞Range取消后不回退；缺失缓存自动完整回退；签名描述被篡改时验签拒绝。旧缓存原文件未改，已安装程序文件未触碰，没有请求生产更新写接口或模型。

首轮直接封装低层请求时，异常Range响应拒绝未正确结束上层Promise；随后在适配层显式传播失败、跟踪并取消活跃请求、改用请求级超时后全部场景通过。此经历证明内部类不能原样直接接入；严谨的传输/取消封装仍是必要工作。

## 生产接入必须保留的约束

1. 沿用原v1索引验签、反重放、协议和独立Build判断，不改成只相信未签名latest.yml。补充签名的不可变每Build描述，精确绑定完整包身份、SHA512和blockmap的SHA256/大小/格式；有界读取并验证块表。
2. 客户端独立保留“基线EXE + 匹配blockmap + 发布身份”，按Build和SHA256命名，不能只按重复的安装包文件名；不能把ready.exe单独当成永久基线。当前recover会删除ready.json，安装包清理功能也可能回收原ready.exe。
3. NSIS模板本来就会自动缓存自身，但缓存可缺失/过期且位置按产品名共享。可借鉴这种自动播种方式；只有与受信身份匹配的副本才可采用。保护独立的已验证基线，不影响用户清理原始下载文件。
4. 差分输出使用独立临时文件；失败时丢弃它，再走原全量断点续传路径，不能把未验证的差分半成品当成完整包前缀。严格校验206、Content-Range、长度、编码和重定向范围；取消活跃请求并限制总时长，取消不触发全量回退。
5. 重构后用现有签名SHA256/大小再验一次；安装前重读当前索引，保留多窗口/会话占用检查和原安装助手。下载完成不等于安装确认，不能提前覆盖旧基线与其块表。
6. 新Build启动确认后再提升缓存对，保持原安装路径、AppId和installationId；无有效基线时完整回退。先验证完整包、blockmap和签名描述，发布通道最后切换；网页链接仍指完整EXE。

这些是后续生产适配的设计要求，不是本轮已经完成的客户端功能。前一轮 `codex/installed-file-delta` 和其 Build 34 候选继续保留作为比较，不合入发布。本轮没有替换线上 Build 33；新实现应从生产main基线开始，不把自研文件安装层混入成熟方法适配。

## 重跑原型

仅在本机隔离开发环境运行，不要用它触发生产安装。先将研究依赖安装到忽略目录，不改项目package.json/锁文件：

```sh
npm install --prefix .local/updater-research --save-exact --no-package-lock --ignore-scripts electron-updater@6.8.10
node scripts/research/nsis-differential-prototype.mjs OLD_EXE OLD_RELEASE_JSON NEW_EXE NEW_RELEASE_JSON OUTPUT_PARENT
```

两个release JSON可以是普通release对象或含release字段的对象，必须记录真实对应安装包的build/protocol/appVersion/sourceCommit/filename/size/sha256；新EXE旁必须有对应`.blockmap`。输出用新建随机子目录，旧EXE只读；fixture证书和签名密钥只用于本地测试。原型不作为桌面运行模块、发布器或生产适配器导入。

[结构化证据](evidence/nsis-updater-evaluation-2026-11-08.json)，[隔离原型](../scripts/research/nsis-differential-prototype.mjs)。
