# 服务端登录与客户端账号编号

2026-10-24。用户选择：在 Ubuntu 服务端终端通过官方 Claude Code 登录、退出和换号，客户端只使用服务端已经登录的账号。

已从源码 `224d7bcae1e4d1e1f37a8b72bfdb3d48cfacaa6a` 正式构建并部署控制中心，发布 Windows Build 6、Linux Build 3（0.3.6／协议20）。用户已回传 Ubuntu `SUCCESS: Linux Build 3 / protocol 20 is installed and committed.`，首台升级完成；重新连接后的编号显示待反馈。后续可从控制中心“客户端更新”页复制专用服务端升级命令，首次接入与后续升级明确区分。详见 [发布记录](ACCOUNT-MODE-RELEASE-2026-10-24.md)。

## 操作与显示

| 位置 | 行为 |
| --- | --- |
| Windows 客户端账号页、账号菜单 | 显示 `CC-7A3F-91C2-6B8D-4E50` 形式的编号、套餐和现有额度/用量；移除 Claude 登录、退出、授权页、授权码及取消登录入口 |
| 客户端未登录状态 | 显示“请在 Ubuntu 服务端登录 Claude Code” |
| CC 控制中心账号页 | 同时显示编号、完整邮箱和账号备注；支持按编号搜索，节点最近绑定也显示编号与邮箱 |
| Ubuntu 服务端终端 | 用户在这里直接使用官方 CLI 管理 Claude 登录状态；凭据保留在原持久化目录 |

编号基于当前监控已有的账号 ID：规范化邮箱（去首尾空格、转小写）的 SHA256，取前16位十六进制字符，转大写并每4位分组，加 `CC-` 前缀。内部关联仍使用完整 SHA256 ID；显示编号不作为登录凭据、权限判断或安全匿名化标识。

同一账号在不同节点、重启或重新登录后保持相同编号。不同邮箱会生成不同编号，换号后显示当前身份的编号；未读到身份时显示编号尚未读取，不回退显示邮箱。控制中心按已有完整 ID 自动得到映射，不需要新的编号分配服务、数据库迁移或 Claude 请求。

## 服务端处理

服务端的 `account.login`、`account.code`、`account.cancel`、`account.logout` 请求统一返回 `account_server_managed`，因此旧客户端也不能通过这些接口修改登录状态；保留原有 `account.status` 读取。`native-account.ts` 是现有受管升级固定校验的文件，保留其原始字节；其中旧的 PTY 登录和退出实现不再被账号入口调用。

账号身份在发给客户端前投影为编号，覆盖 `account.state`、实时 native capabilities、fragment 和历史 snapshot；邮箱、组织字段及登录 URL/notice 不随这些账号身份消息发给客户端。原始会话数据库不改写，私有监控在投影前消费真实身份，控制中心仍收到原有白名单邮箱及套餐信息。

范围是客户端账号展示与身份元数据。会话正文、用户输入、工具输出和官方原生终端文本保持原样；其中若自行输出邮箱，不做全局文本替换。这也不是阻止具备终端/工具执行权限的管理员运行官方命令的权限隔离方案。

## 将来在 Ubuntu 登录/换号

当前账号已登录，不需要为这次开发重新登录。以下命令用于未来需要管理账号时；开发验证没有执行它们。

先结束所有会话任务和原生终端，并退出所有 CC 连接窗口（包括托盘中的连接），再在 Ubuntu 控制台操作。继续使用容器默认业务用户，不加 `--user root`。Node 的 env-file 与业务启动保持一致，官方 CLI 自己读写原有凭据；不要在 Ubuntu 宿主的其他 HOME 下另装一套 CLI 登录。

登录：

```bash
sudo docker exec -it cc-desk-tunnel-ba938975-proxy-1 /opt/runtime/node/bin/node --env-file=/data/config/service.env --input-type=commonjs -e 'const p=require("node:child_process").spawn("/opt/runtime/cli/bin/claude",["auth","login"],{stdio:"inherit",env:process.env});p.on("exit",c=>process.exit(c??1));'
```

退出（仅在确实需要退出/换号时）：

```bash
sudo docker exec -it cc-desk-tunnel-ba938975-proxy-1 /opt/runtime/node/bin/node --env-file=/data/config/service.env --input-type=commonjs -e 'const p=require("node:child_process").spawn("/opt/runtime/cli/bin/claude",["auth","logout"],{stdio:"inherit",env:process.env});p.on("exit",c=>process.exit(c??1));'
```

按官方终端提示完成浏览器授权，授权码只输入该 Ubuntu 官方 CLI 终端。完成后重新连接 CC，沿用既有账号状态读取与被动上报。客户端连接服务所用的地址、证书指纹和 CC 服务凭据仍是另一套连接认证。

## 发布安排与验证

账号编号字段为协议20的可选扩展，保留旧字段供内部/旧数据读取；未修改官方 CLI、SDK、JEV、模型调用或凭据格式。控制中心可先上线编号展示，旧节点报告也能直接映射。再发布新的 Windows 与 Linux 构建，完成配套升级；旧服务端不会提供编号，新客户端连接它时显示“账号编号尚未读取”。新服务端发给旧客户端的账号信息也不会包含邮箱，但旧界面不认识编号。

本轮 review 修复保持 Build 2 的完整兼容性校验闭包与依赖锁不变：编号及客户端解析扩展位于独立的 `packages/protocol/src/account-display.ts`，原 `index.ts` 的持久化协议定义不变；服务端只在发送边界做身份投影。未修改兼容性白名单、bootstrap profile 或放宽摘要校验。以已发布源码 `9ab5f49f8155076ae5d7eacb33d9e369da4e2199` 的固定摘要作为离线回归基线，签名模拟 Build 3 经现有监督程序检查返回 `compatible=true`、`reason=available`；因此本需求可沿用已有受管程序升级路径，无需为此更换基础镜像。正式 Linux 归档已在无网络、无账号挂载的隔离 Docker 环境验证 Build 3、健康、就绪、SIGTERM 及零 CLI 执行。真实 Ubuntu 的升级与回滚仍待实机验收。

控制中心打包清单已补入 `account-number.ts`。离线回归实际生成归档、解压并在无工作区依赖的目录导入 HTTP 模块，防止源码测试通过而部署时缺少文件。服务端打包回归同时检查展示模块、编号模块和发送投影模块都进入归档。

已正式签名发布 Windows Build 6（revision 11）与 Linux Build 3（revision 5），完整下载摘要通过验证，续期已登记并恢复。未覆盖历史 Build 5/2；Ubuntu 业务节点尚未执行本次升级。

review 修复后已重新完成 Node v24.22.1 TypeScript 检查、生产前端构建、单次74项相关回归（含实际归档完整性、升级兼容性准入与客户端编号解析），以及真实 React 开发页面中的模拟 WebSocket 验证：编号、邮箱隐藏、远程登录控件移除、未登录提示和零页面错误。测试未使用真实账号、未执行 Claude/SDK 会话、未调用 JEV 或额度接口。证据见 [验证记录](evidence/server-managed-accounts-2026-10-24.json)。
