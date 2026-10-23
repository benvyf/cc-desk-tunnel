# 定制更新索引签名

本工具是 [VPS 更新通道设计](superpowers/specs/2026-10-23-vps-update-channel-design.md) 的交付 A：离线签名、验签及候选判断。它不会上传文件、部署 VPS、启用客户端升级或改变现有服务端。运行要求 Node 24；没有新增依赖。

生产管理方式已于 2026-10-23 调整为 [VPS 统一发布](VPS-RELEASE-CREDENTIALS.md)：私钥在 VPS 的 root 私有目录中保存，通过 SSH 运行签名与发布工具。以下本地签名命令仍可用于离线场景，不代表当前生产凭据位于开发电脑。

## 文件和 API

- `packages/managed-updates/src/index.ts`：仅用于 Node 的共享契约，勿引入 renderer 协议入口。
- `scripts/sign-managed-update.mjs`：管理员离线发布工具。
- `validatePayload(value, now)`：严格校验并冻结载荷。
- `signIndex(payload, keyId, privateKey, now)`：返回签名信封 Buffer。
- `verifyIndex(bytes, trustedKeys, now)`：限制 64 KiB、严格校验信封、规范 Base64、Ed25519 验签后解析载荷，返回冻结的载荷与原始载荷字节 SHA256。trustedKeys 由调用方可信配置提供，不能从网络索引生成。
- `selectUpdate(verifiedIndex, installedIdentity, previousState)`：纯函数，返回状态、可用 release 或 null、待保存 nextState；拒绝 revision 回退、同 revision 内容改变及已观察到的同 build 制品身份改变。
- `artifactPath(release)`：从严格字段构造固定下载路径，不接受 URL。

`now` 为毫秒 Unix 时间，默认使用系统时间，显式值仅供测试。调用方必须在使用前重新验签；已返回的对象不是永久有效的安装许可。未来控制器负责固定可信公钥、限制网络响应、持久记录、锁、下载校验和安装前重新获取索引。本模块不访问网络或磁盘状态。

`previousState` 按产品、通道、平台和架构隔离，不能跨通道复用。字段包括最高 revision、原始 payloadHash、兼容协议下最高已观察 build 和其制品身份 hash。相同 build、相同制品可持续作为候选及续期；已安装 build 或更低 build 不提供安装候选。观察到更高 build 后，即使撤回，也不再提供较低 build。不同协议只提升 revision，不接受其制品。notes 允许编辑；它是未经信任的纯文本，消费者必须用文本方式显示，不能解释 HTML。

## 准备输入

管理员保管 Ed25519 私钥，放在源码树、发布输出目录之外；工具通过真实路径检查目录联接和符号链接。此工具不生成密钥。私钥不放入安装包，不纳入 Git，不对网站或更新服务账号开放。当前生产私钥在 VPS 的 root 私有目录保存。公钥及 keyId 在客户端打包交付中固定；本工具不会替客户端登记新公钥。

每次发布先确认构建源码清洁并已提交。准备 `payload.json`，`sourceCommit` 填写该构建的完整 40 位小写提交，时间改为当前 UTC 时间及最多 7 天后的到期时间。下例只是字段格式，不是生产签名配置：

```json
{
  "schema": 1,
  "product": "cc-desk-tunnel-managed",
  "channel": "pilot",
  "platform": "win32",
  "arch": "x64",
  "revision": 1,
  "issuedAt": "2026-10-23T00:00:00Z",
  "expiresAt": "2026-10-26T00:00:00Z",
  "state": "published",
  "release": {
    "build": 1,
    "appVersion": "0.3.6",
    "protocol": 20,
    "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
    "notes": "首次支持定制更新通道的版本。",
    "filename": "CC-Desk-Tunnel-Setup-0.3.6-x64.exe"
  }
}
```

输入不填写 `size` 和 `sha256`，由工具流式读取安装包计算。其他对象字段严格匹配，不接受未知字段。安装包最大 1 GiB，notes 最多 8,000 个 JavaScript 字符；所有整数为正安全整数。文件名必须与应用版本精确匹配。

安装包、输入 JSON 和输出通常放在源码树外的专用发布目录，私钥放另一个受保护目录。输出父目录须已存在，输出文件须不存在。不要把正在使用的 VPS 索引作为本工具输出路径。

## 发布命令

在仓库根目录运行（PowerShell 示例路径需按实际位置替换）：

```powershell
node scripts/sign-managed-update.mjs `
  --input C:/cc-release-input/payload.json `
  --key-id managed-2026 `
  --private-key C:/cc-signing-private/ed25519.pem `
  --source C:/cc-source-clean `
  --artifact C:/cc-release-files/CC-Desk-Tunnel-Setup-0.3.6-x64.exe `
  --out C:/cc-release-output/pilot-revision-1.json
```

工具检查 `--source` 是 Git 根目录、HEAD 等于 sourceCommit、无已跟踪修改或未跟踪文件，并从该提交读取桌面版本和协议常量。读取安装包前后检查文件状态，签名前后核对源码。工具将索引自验签成功后，以排他新建方式写出；已有文件和输出符号链接不会被覆盖。失败不会输出私钥、输入 JSON 或 Git 错误内容。

此阶段核对的是管理员提供的源码身份与文件哈希，**尚不能证明任意 EXE 确实由该提交构建**。需由管理员核对原构建记录，打包交付已嵌入定制构建身份。工具不负责全局分配 build 或保存发布历史，管理员必须保证 build 全局递增、每个通道 revision 递增；[独立更新服务](UPDATE-SERVICE.md)负责持久校验和激活，现已[部署生产](UPDATE-SERVICE-PRODUCTION.md)，当前 build 2 已发布到 pilot，stable 保持空通道。

既有 `managed-preview-fd6e213` 安装包没有新通道身份，不能将其追溯标为 build 1。工具测试仅使用临时测试密钥及非可执行的安装包 fixture；随后正式部署建立了生产签名身份和 revision 1 空通道，首次真实安装包应使用更高 revision。

## 续期、撤回和回滚

建议每 3 天在管理员电脑重新签名续期：保持同一 build、制品身份、文件大小和 hash，增加该通道 revision，更新 issuedAt/expiresAt。签名有效期不得超过 7 天。即使没有新版本，也必须续期；过期缓存不能用于安装。

撤回输入使用完整载荷外层，增加 revision，设置 `state` 为 `empty`、`release` 为 null。不传 `--source` 和 `--artifact`：

```powershell
node scripts/sign-managed-update.mjs `
  --input C:/cc-release-input/withdrawal.json `
  --key-id managed-2026 `
  --private-key C:/cc-signing-private/ed25519.pem `
  --out C:/cc-release-output/pilot-revision-2.json
```

输出仅为待发布签名文件，不会自行撤回线上版本。VPS 已实现激活及更高 revision 防回放，客户端安装前再次获取索引仍属于后续客户端交付。撤回不逆转已完成安装。回滚采用旧源码重新构建并使用更高 build，不给旧二进制仅更改清单 build。

pilot 验证后可以对同一制品生成 stable 签名索引；stable 使用自己的 revision 序列。不要改动已签名文件内容；签名覆盖 keyId 与 payload 原始 Base64 字符串。格式为：

```text
UTF8("CC-DESK-TUNNEL-UPDATE-V1\n" + keyId + "\n" + payload)
```

## 本地验证

```powershell
node --test apps/desktop/test-main/update-contract.test.mjs apps/desktop/test-main/update-publisher.test.mjs
npm run typecheck
npm test
npm run build
npm run format:check
```

测试动态生成密钥，在系统临时目录使用后清理，不把私钥 fixture 或签名成品提交仓库。旧升级 IPC 和服务端普通客户端更新命令的拒绝测试仍属于完整测试套件。
