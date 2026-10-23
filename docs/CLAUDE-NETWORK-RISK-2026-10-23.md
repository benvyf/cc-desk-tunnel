# 单节点升级后的 Claude 网络与账号风险核对

2026-10-23，香港时间。用户要求先核实网络及账号风险再继续。Windows 客户端验收暂缓，不发送模型请求，不启动账号登录或修改网络配置。生产 `ubuntu-cc` 已运行协议 20；不会因这次询问擅自回滚或扩大迁移。

## 已确认与尚未确认

用户已明确：**只有本人使用自己的 Claude 订阅**。不再将“多人共用管理员订阅”为当前使用方式；下文相关条款仅说明边界。

用户已回传 `8664d36` 离线检查结果：旧/新 CLI 均 2.1.293，CLI 主文件字节一致；`native-account.ts`、`native-onboarding.ts` 和 `usage.ts` 也一致。Docker 实际网络相同、检查的代理/提供方环境变量无差异，service.env、provider.json 和 home settings 均与备份一致，没有配置代理/替代提供方变量，发现官方 CLI 保存的 OAuth 登录，没有 API/auth 环境变量凭据。

但旧生产镜像的 `claude.ts`、`native-terminal.ts` 和 `config.ts` 与新镜像字节不同，Docker 路由选项原始比较也不同。不能据此说逻辑必然不同（可能是换行或空值序列化），也不能沿用“调用代码未改”的结论。前一次仓库参考提交比较不能代表旧生产镜像。新增只读 `scripts/detail-ubuntu-network-risk.py` 只核对这三份源码的换行归一化指纹及具体路由选项的空值差异，不重复 CLI、凭据或配置检查，不启动 Claude。待回传结果后与本仓库历史内容匹配并分析真实改动。

- 本次切换校验了原服务配置、provider 配置、证书及私钥文件未变，三项独立流量开关保持 1。服务令牌和 TLS 指纹保持，公网健康及本地认证通过；这些只能证明 CC 连接，不代表实际模型出口已验证。
- 固定源码 `4a39bc3` 的安装脚本使用官方 npm 包 `@anthropic-ai/claude-code@2.1.293`；旧生产盘点的 CLI 版本也是 2.1.293。与参考提交 `6701a10` 相比，模型调用、CLI 安装、原生认证/终端、本机 OTEL 及 Docker 入口文件没有 diff；参考提交不是已证明的旧生产镜像源码身份，不能代替镜像实测。
- 当前链路中 VPS 的 8443 端口中转 CC 的 TLS 连接，不能据此推断 Claude 模型请求也从 VPS 出口发出。Ubuntu NAT、Windows TUN/VPN、Claude 单独代理及提供方地址仍决定模型出口。
- 首次脚本 `scripts/check-ubuntu-network-risk.py` 对旧镜像及当前镜像分别启动无挂载、只读、`--network none` 的临时 Node 容器，只读取已安装 CLI 及相关源码字节；不启动 Claude。另比较旧/新 Docker 网络、路由选项与环境变量，以及备份和当前网络配置，输出布尔值及变量名，不输出密钥、账号邮箱、代理地址或令牌。结果已回传，见本节开头。
- 代码中原有的 `native-onboarding.ts` 会读取本地 CLI 凭据文件判断登录，并设置本地首次引导完成标志；因此不能笼统声称 CC 代码完全不接触凭据文件。这不是本次新引入的逻辑。

## 官方公开说明

本次直接读取当前可访问的官方 Markdown 文档：

- [数据使用与遥测](https://code.claude.com/docs/en/data-usage)：公开支持 `DISABLE_TELEMETRY=1` 和 `DISABLE_ERROR_REPORTING=1`。遥测关闭也会影响功能开关获取；这不是防风控保证。
- [环境变量](https://code.claude.com/docs/en/env-vars)：列有 `DISABLE_AUTOUPDATER` 等配置。固定版本长期不维护仍有兼容及安全更新的风险，不应把禁用自动更新当作永久不升级。
- [企业网络配置](https://code.claude.com/docs/en/network-config)：支持 HTTP/HTTPS 代理及自定义 CA。支持代理不等于对特定出口、地区或账号用法的认可。
- [法律与合规：认证及凭据使用](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)：用户可在平台托管的、未修改的 Claude Code 中以自己的订阅登录；第三方开发者不得替其他用户通过 Free/Pro/Max 凭据路由请求，也不得收集、存储或中转 Claude.ai 凭据/会话令牌来提供自己的登录。托管/预装条款还要求不修改 CLI、每位最终用户以自己的合规凭据认证，且不代付、转售或中转用量。具体使用模式需确认，不能把“使用官方二进制”当作涵盖全部条款的豁免。

## 当前判断

尚不能给出“没有风险，可以继续”的保证。本人自用已确认，官方 CLI 主文件也未变；但三份 CC 源码及 Docker 路由选项差异仍待解释，实际模型出口也未验证。没有证据表明协议 20 或这三个公开开关本身必然导致封号。即便模型请求全部成功，也不能证明账号后续不会被风控。

个人自用方式已确认；还需要解释实际源码和路由选项差异，再决定下一步。若以后改成多人共享同一个 Pro/Max 订阅为他人提供服务，需重新评估官方条款风险。当前不执行模型测试、代理切换、重新登录或账号身份伪装。
