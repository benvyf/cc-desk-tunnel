# 单节点升级后的 Claude 网络与账号风险核对

2026-10-23，香港时间。用户要求先核实网络及账号风险再继续。离线核对和实际差异分析已完成：在下述已检查范围内，未发现这次升级新增 Claude 联网或账号风控风险的证据，建议恢复不发送模型消息的 Windows 客户端验收。模型测试继续暂停，不启动账号登录或修改网络配置。生产 `ubuntu-cc` 已运行协议 20；不因这次询问擅自回滚或扩大迁移。

## 实际差异结论

用户已回传 `df73d13` 的目标机明细。旧、新三份源码的六个归一化 SHA256 均与本地 Git 文件内容匹配：旧文件均可匹配 `50c7896982cd95d7c8254355ec9e670696f75efa` 中的相应文件，新文件匹配实际发布源码 `4a39bc35008707366949496f9219e9b68c8d0856`。这确定了被比较的文件内容，不代表已确定整个旧镜像的构建提交。

| 差异 | 实际含义及联网影响 |
| --- | --- |
| `claude.ts` | SSH 执行连接改为可选；有 SSH 时保持附加远程操作提示词，无 SSH 的服务端自有会话不附加。改变执行指令的选择，没有改变模型 endpoint、代理、认证或请求出口设置。 |
| `native-terminal.ts` | 同样按有无 SSH 决定是否传入 `--append-system-prompt`；provider、模型、设置文件和 CLI 环境处理没有变化。 |
| `config.ts` | 删除旧 `options.updates` 配置，停止采用旧 GitHub 仓库跟踪/下载入口；不是新增 Claude 请求通道。 |
| Docker `NetworkMode` | 旧、新均为 `cc-desk-tunnel-ba938975_default`，实际 NetworkID 也相同。 |
| Docker `Dns` / `DnsSearch` | 旧为 `[]`，新为 `null`，均未设置 DNS 覆盖或搜索后缀。首次比较将这种序列化差异计为不相等，不能解释为配置了新的 DNS。 |
| Docker `ExtraHosts` | 两边均为空列表。 |

CLI 主文件和认证/统计代码不变、持久配置不变、无新增代理/提供方环境变量及本人自用等证据，见下一节。无需为了上述空值表示或已解释源码变化回滚。建议继续连接、历史、普通工作区文件浏览及原生终端显示/关闭的非模型验收，不发送提示词、不改变账号或代理、不扩展其他节点。

证据保存于本地 `artifacts/server-pilot-4a39bc3/network-risk-fingerprint-analysis.json`，目标机脱敏明细在 `/var/lib/cc-desk-tunnel-pilot-4a39bc3/network-risk-details-sanitized.json`。本次没有发送模型请求或实际出口探测，也未改动生产。

## 已确认与尚未确认

用户已明确：**只有本人使用自己的 Claude 订阅**。不再将“多人共用管理员订阅”为当前使用方式；下文相关条款仅说明边界。

用户已回传 `8664d36` 离线检查结果：旧/新 CLI 均 2.1.293，CLI 主文件字节一致；`native-account.ts`、`native-onboarding.ts` 和 `usage.ts` 也一致。Docker 实际网络相同、检查的代理/提供方环境变量无差异，service.env、provider.json 和 home settings 均与备份一致，没有配置代理/替代提供方变量，发现官方 CLI 保存的 OAuth 登录，没有 API/auth 环境变量凭据。

首次发现旧生产镜像的三份源码与新镜像字节不同，Docker 路由选项原始比较也不同后，没有沿用“调用代码未改”的结论。前一次仓库参考提交比较不能代表旧生产镜像。随后使用只读 `scripts/detail-ubuntu-network-risk.py` 核对这三份源码的归一化指纹及路由选项，不重复 CLI、凭据或配置检查，不启动 Claude。现已回传、匹配并分析实际改动，结论见上节。

- 本次切换校验了原服务配置、provider 配置、证书及私钥文件未变，三项独立流量开关保持 1。服务令牌和 TLS 指纹保持，公网健康及本地认证通过；这些只能证明 CC 连接，不代表实际模型出口已验证。
- 固定源码 `4a39bc3` 的安装脚本使用官方 npm 包 `@anthropic-ai/claude-code@2.1.293`；旧生产盘点的 CLI 版本也是 2.1.293。与参考提交 `6701a10` 相比，模型调用、CLI 安装、原生认证/终端、本机 OTEL 及 Docker 入口文件没有 diff；参考提交不是已证明的旧生产镜像源码身份，不能代替镜像实测。
- 当前链路中 VPS 的 8443 端口中转 CC 的 TLS 连接，不能据此推断 Claude 模型请求也从 VPS 出口发出。Ubuntu NAT、Windows TUN/VPN、Claude 单独代理及提供方地址仍决定模型出口。
- 首次脚本 `scripts/check-ubuntu-network-risk.py` 对旧镜像及当前镜像分别启动无挂载、只读、`--network none` 的临时 Node 容器，只读取已安装 CLI 及相关源码字节；不启动 Claude。另比较旧/新 Docker 网络、路由选项与环境变量，以及备份和当前网络配置，输出布尔值及变量名，不输出密钥、账号邮箱、代理地址或令牌。结果已回传，见本节开头。
- 代码中原有的 `native-onboarding.ts` 会读取本地 CLI 凭据文件判断登录，并设置本地首次引导完成标志；因此不能笼统声称 CC 代码完全不接触凭据文件。这不是本次新引入的逻辑。

## 连接和浏览历史时的自动状态查询

用户已连接 build 2 并确认历史可读，随后询问是否会连接 Claude。源码显示，`apps/desktop/src/App.tsx` 在原生模式连接后自动请求 `account.status`，首次显示空闲会话并加载历史后会自动刷新 `session.status`。服务端前者经 `native-account.ts` 调用官方 CLI 的 `auth status --json`；后者可能经 `claude.ts` 的 `readNativeStatus` 启动官方 CLI/SDK，读取初始化及状态结果，输入生成器不提交用户提示词。

因此，连上自己的 CC 服务不等于自动发送聊天模型请求，但当前自动状态查询可能联系 Anthropic 获取登录、额度等辅助信息，不能将客户端连接或浏览历史描述为完全离线。仅凭源码不能断定每次 `auth status` 都会联网，也没有对用户实际 GUI 操作抓包。之前受控检查中的 `modelRequests:0` 表示这些检查没有提交模型提示词，不是“零 Anthropic 网络流量”的证据。此处仅记录已核对的行为，没有修改自动刷新逻辑、启动客户端或执行模型测试。

## 官方公开说明

本次直接读取当前可访问的官方 Markdown 文档：

- [数据使用与遥测](https://code.claude.com/docs/en/data-usage)：公开支持 `DISABLE_TELEMETRY=1` 和 `DISABLE_ERROR_REPORTING=1`。遥测关闭也会影响功能开关获取；这不是防风控保证。
- [环境变量](https://code.claude.com/docs/en/env-vars)：列有 `DISABLE_AUTOUPDATER` 等配置。固定版本长期不维护仍有兼容及安全更新的风险，不应把禁用自动更新当作永久不升级。
- [企业网络配置](https://code.claude.com/docs/en/network-config)：支持 HTTP/HTTPS 代理及自定义 CA。支持代理不等于对特定出口、地区或账号用法的认可。
- [法律与合规：认证及凭据使用](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)：用户可在平台托管的、未修改的 Claude Code 中以自己的订阅登录；第三方开发者不得替其他用户通过 Free/Pro/Max 凭据路由请求，也不得收集、存储或中转 Claude.ai 凭据/会话令牌来提供自己的登录。托管/预装条款还要求不修改 CLI、每位最终用户以自己的合规凭据认证，且不代付、转售或中转用量。具体使用模式需确认，不能把“使用官方二进制”当作涵盖全部条款的豁免。

## 当前判断

本次升级所发现的差异已解释，未发现新增 Claude 联网或账号风控风险的证据，可继续非模型客户端验收。这是对已检查改动的判断，不是对第三方客户端整体、账号条款全面合规或未来封控结果的保证。本人自用和未修改 CLI 是积极证据，不能代表 Anthropic 已认可所有集成方式。

实际模型出口、Windows TUN/VPN 状态及地区可用性仍未验证；Docker 配置等价不能证明宿主机网络始终不变。即便一次模型请求成功，也不能证明账号后续不会被风控。若以后改成多人共享同一个 Pro/Max 订阅为他人提供服务，需重新评估官方条款风险。模型测试、代理切换、重新登录和账号身份伪装均未执行。
