# 回答中的生成文件引用

助手最终回答中，反引号包裹的文件名现在可以点击，在现有右侧侧栏中预览。

- 文件名优先匹配本轮成功的 `Write`、`Edit`、`MultiEdit`、`NotebookEdit` 记录。同名文件有歧义时不生成链接。
- 对命令生成的文件，支持明确的绝对路径、`./` 或 `../` 路径，以及“`C:\成果目录\` 下的 `报告.pdf`”形式。目录需要以路径分隔符结尾；不会将没有依据的裸文件名拼到项目目录。
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
