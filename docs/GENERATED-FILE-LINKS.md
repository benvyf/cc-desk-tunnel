# 回答中的生成文件引用

助手最终回答中，反引号包裹的文件名现在可以点击，在现有右侧侧栏中预览。

- 文件名匹配本轮成功的 `Write`、`Edit`、`MultiEdit`、`NotebookEdit` 记录，支持 `out/report.pdf`、Windows 分隔符及 `README` 等无扩展名的已记录产物。同名文件有歧义时不生成链接。
- 对命令生成的文件，支持明确的绝对路径、`./` 或 `../` 路径，以及“`C:\成果目录` 下的 `报告.pdf`”形式。目录末尾的分隔符可省略，也支持名称含点的目录。
- 明确指定的目录优先于其他目录下的同名文件；目录作用范围止于相关段落或文件列表，不跨章节延续。如果前面的路径实际是参考文件而非目录，会回到本轮唯一的已记录目标；不存在的目录不会重定向到其他同名文件。
- 文件系统路径与 URL 地址分开处理，保留文件名中的字面 `%20`、`%2520` 和 `#`；路径后的 `:12:3`、`#L12C3` 行列位置会传递给预览。
- Windows 文件名匹配忽略大小写并接受两种分隔符；POSIX 文件名匹配区分大小写，反斜杠保留为文件名字符，不会被拆成目录。
- 只有本机检查确认存在的文件才显示链接。浏览器或其他设备上的会话不会检查本机文件。
- 点击、回车、悬停路径提示和右键菜单复用普通文件链接的逻辑。用户消息、代码块和已有 Markdown 链接不增加嵌套链接。

识别方式参考 deepseek-harness 的 [producedFileMentions](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-deliverables/src/client/turn-deliverables.ts)；命令产物通过已有 `inspectPath` 验证，不解析命令脚本来推断输出路径。

## 验证

使用 Node 24：

```powershell
node --test apps/desktop/test-main/file-mentions.test.ts apps/desktop/test-main/links.test.mjs apps/desktop/test-main/file-links.test.mjs apps/desktop/test-main/transcript.test.mjs
npx playwright test apps/desktop/test/file-mentions.spec.ts apps/desktop/test/links.spec.ts apps/desktop/test/code-block.spec.ts
npm run typecheck
npm run build
```

UI 测试使用真实 Conversation、预览工作区与 PreviewSidebar，文件检查和读取通过测试接口提供。它验证中文 DOCX/PDF 引用打开正确的侧栏标签，文件格式转换仍由已有预览实现负责；未通过已安装客户端测试 Word/PDF 转换。

复审补充用例覆盖：原始文件名与其 URL 解码后名称同时存在时仍打开原文件，目录作用范围结束后选择正确源码文件，实际文件不被当作目录，以及迟返回或失败的异步文件检查。
