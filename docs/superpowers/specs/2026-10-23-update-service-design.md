# VPS 更新服务实施设计（交付 B）

依据已批准的 [总设计](2026-10-23-vps-update-channel-design.md)，本步实现独立分发/管理服务和网页，不接入 GhostAPI 身份、数据库或 CC 会话，不部署生产服务，不生成生产凭据。现有客户端仍关闭在线升级。

## 结构和发布一致性

使用 Node 24 内置 HTTP、SQLite 和文件流，无第三方运行时依赖。程序仅监听 127.0.0.1。Nginx 提供 HTTPS、安装包 GET/HEAD 和 Range；Node 提供管理网页/API及签名通道索引。SQLite 中的 active channel 行是索引唯一来源，事务切换代替静态 JSON 文件替换，避免数据库与公开文件两处提交不一致。元数据响应禁止缓存，公开安装包不可变。

数据根下 private/ 存数据库和候选文件，public/artifacts/ 存完整安装包。私有目录 0700，公开目录 0755、安装包 0644；Nginx 只获公开文件读取权限。候选先保存签名索引，再上传原始 EXE。上传流限制为签名 size 且最大 1 GiB，实际流式计算 hash；失败及中断删除临时文件，不公开。

SQLite 另开 owner.sqlite 持有进程级排他事务，阻止多个服务共享数据目录写入，进程退出/崩溃后由 OS 自动释放。单进程修改操作采用全局排他锁，冲突返回 409，读取不阻塞。候选最多 8 个，同时只有一个修改/上传操作。

激活时重新验签并校验候选，检查通道 revision（相同 revision/相同原始载荷为幂等重试，其他回退或同 revision 改内容拒绝）。build 是跨通道全局身份，新 build 必须超过已保留的最大 build，同 build 的版本、协议、提交、文件名、size 和 hash 必须一致，notes 可变化。已有合法制品可供续期及 stable 推广复用，无需重传。

先在数据库持久保留 build 身份，再将已校验、已同步的完整文件以排他硬链接放入公开路径，最后一个 SQLite 事务切换 channel 并写入发布审计。意外退出最多留下未激活的完整文件或 reserved build，不暴露半文件或半索引；reserved build 不复用为其他内容，可用原签名身份重试。先完成文件再提交索引。启动清理 .part 文件，保留有效候选及历史 build。公开制品文件如已存在则重新计算大小/hash，绝不覆盖。撤回只激活更高 revision 的 empty 签名索引，不删除历史安装包。

## 管理身份与网页

首版为单管理员、独立令牌，配置只保存令牌 SHA256 和管理员名称。每个 API 请求用 Authorization Bearer 提交至少 32 字符令牌，服务端限长后做固定长度 hash 比较。令牌仅保存在当前页面 JS 内存，不放 cookie、URL、localStorage 或日志；刷新/退出即丢弃。使用无 cookie 的逐请求认证，因此不建立持久登录 session。

所有修改请求还必须带与配置 HTTPS origin 精确一致的 Origin 和指定 Content-Type；读取请求如带 Origin 也须相同。不开放 CORS。拒绝认证失败的请求后不读取大请求体。失败认证有服务级限速，Nginx 建议补来源限速。页面设置 CSP（禁止内联脚本/样式）、禁止嵌入、nosniff、no-store；动态字段和 notes 只用 textContent。

网页提供管理员登录、pilot/stable 当前发布/过期状态、签名索引选择、候选安装包上传、激活或撤回、删除未激活候选、最近审计。服务不保管签名私钥，管理令牌不能重签索引。日志只记录管理员、时间、动作、channel、revision、build、sourceCommit 和 hash，不记录认证或正文。

## HTTP 边界

- `GET /cc-updates/admin/` 及 app.js/style.css：固定网页资源。
- `GET /cc-updates/admin/api/status`：认证后返回通道、候选和最近 100 条审计。
- `POST /cc-updates/admin/api/candidates`：application/json，最大 64 KiB，正文即签名信封。
- `PUT /cc-updates/admin/api/candidates/{uuid}/artifact`：application/octet-stream，原始 EXE；仅 published 候选允许。
- `POST /cc-updates/admin/api/candidates/{uuid}/activate`：application/json，正文必须 `{}`。
- `DELETE /cc-updates/admin/api/candidates/{uuid}`：删除候选及私有上传文件。
- `GET|HEAD /cc-updates/v1/channels/{pilot|stable}/win32-x64.json`：返回原始签名信封；未发布为 404，不生成无签名 empty 响应。
- 安装包由 Nginx 精确匹配固定路径直接分发，拒绝目录浏览及其他文件。

请求有头部/正文大小限制和超时，上传最长 10 分钟。路径精确匹配，候选只接受 UUID，路径不来自用户文件名。错误为固定文案，不返回堆栈、配置、正文或凭据。

## 验证及运维交付

Node 集成测试使用临时公私钥、临时目录和 loopback HTTP；覆盖发布/续期/推广/撤回、鉴权/Origin、篡改/超量/断传、revision/build 约束、并发、进程锁、重启恢复、失败激活保留当前索引。网页用浏览器验证真实操作流程及文本渲染。提供最小源码归档、systemd、Nginx 样例和配置说明，无 Docker socket 或现有服务目录挂载。

本机没有 Linux/Docker，不能用 Windows 测试声称通过实际 Nginx HTTPS/Range 或 Linux systemd 验证。真实域名、TLS、配置权限、空闲端口及公钥核对后，仍须完成测试 Linux 验收再部署 VPS；本轮提供实现、可审查归档和明确验收指令。
