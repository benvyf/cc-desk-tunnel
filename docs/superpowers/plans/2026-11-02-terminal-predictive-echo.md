# CC SPACE 终端预测回显修改计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 executing-plans 逐任务执行本计划。用户已授权执行；实际结果见文末执行记录。

**Goal:** 改善远程原生终端的中英文输入回显延迟，确保预测失败不会改变实际发送的输入。

**Architecture:** 保留现有逐键 WSS→PTY→官方 CLI 链路。客户端在已经识别的普通输入区显示可撤销预测，以远端解析后的画面为最终依据；不确定时关闭预测。先验证真实 TUI 兼容性，再接入默认关闭的本机设置。

**Tech Stack:** React 19、TypeScript、xterm.js 6.0.0、候选插件 xterm-zerolag-input 0.4.2、Node 24 node:test、Playwright、Electron 44。

---

## 0. 计划状态与边界

- 日期：2026-11-02，Asia/Hong_Kong。
- 源码根目录：`C:/Users/benben/Desktop/桌面文件夹集合/cc-desk-tunnel/source`。
- 读取时基线：`main@d22dd8d`。执行前重新确认 HEAD、工作树和已有约定，不能直接覆盖后续改动。
- 本文替代旧方案中“先宽松预测、后补门控”“默认 auto”“收到第一段输出即认为得到 RTT”的实施安排。
- 已确认：插件能绘制简单预测；xterm 6 的 Unicode getter 需要开启 proposed API；插件实际使用内置宽度表；上滚和刷新字体需额外清理；任意解析输出都可能解除插件内部等待状态。
- 尚未确认：真实 Claude Code 的光标/输入区能否可靠识别、背景刷屏下的收敛、Windows 中文输入法事件次序、真实收益。任务 1 专门决定这些前提是否成立。

**最小范围：** 只新增预测显示、一个本机开关及必要验证。先覆盖稳定普通输入区行尾的 ASCII、常用汉字与已经验证的中文标点；中文输入法提交的短文本也作为验收目标。输入法候选/组字继续交给 xterm。不预测菜单、审批、登录、密码/令牌输入、方向键、复杂编辑、粘贴和未知状态。

**暂不加入：** 自动 RTT 检测、网络探测、后台统计上报、完整 Mosh 协议、自研通用终端编辑器、新的 Unicode addon、客户端模型接口、协议或服务端功能。不开启默认 auto，不扩展成通用插件框架。

**行为约束：**

1. 输入字节内容、顺序和发送次数与原路径一致；不等待预测、不缓冲到 Enter、不因错配重发。
2. 预测内容不能写入 xterm 的真实 buffer、剪贴板、选区或会话历史。
3. 预测创建、绘制、清理异常均不能阻断原输入。
4. 关闭开关立即清空；不关闭或重建远端终端进程。
5. 纯输出流无法严格证明远端输入语义；不能宣称等同于 Mosh 的按键序列确认。门控无法达到任务 1 标准时，不把宽松预测带进产品。

## 1. 文件安排

所有路径相对上面的源码根目录。执行者只在这些职责内修改。

| 文件 | 处理 | 职责 |
| --- | --- | --- |
| apps/desktop/src/terminalPrediction.ts | 新增 | 小型接入模块：输入分类、预测门控、插件生命周期、异常降级；不发送网络消息 |
| apps/desktop/src/NativeTerminal.tsx | 修改 | 在已有 onData、输出解析、状态变化、粘贴入口及卸载处接入 |
| apps/desktop/src/prefs.ts | 修改 | 一个 boolean 偏好 terminalPredictiveEcho，默认 false，沿用现有共享机制 |
| apps/desktop/src/SettingsPage.tsx | 修改 | 沿用 Row/Switch，增加设置行和搜索词 |
| apps/desktop/package.json、package-lock.json | 修改 | 只锁定候选插件 0.4.2；xterm 保持 6.0.0 |
| apps/desktop/test-main/terminal-prediction.test.ts | 新增 | 输入分类、异常隔离、状态失效与字节一致性测试 |
| apps/desktop/test/terminal-predictive-echo.spec.ts | 新增 | 真实 xterm + 延迟/错配/刷屏夹具，验证 DOM 和最终 buffer |
| apps/desktop/test/terminal-window.fixture.tsx | 修改 | 加入可控回声和测试观测；只存在于测试 |
| apps/desktop/test/terminal-window.spec.ts | 修改 | 增补真实 Electron 窗口下的开关、焦点和清理回归 |
| apps/desktop/test/settings-pages.spec.ts | 修改 | 偏好默认、保存、跨窗口同步、搜索与开关验证 |
| apps/desktop/public/third-party/xterm-zerolag-input.txt | 新增 | 从实际安装包复制完整 LICENSE，供桌面和 Web 构建携带 |
| NOTICE | 修改 | 补充插件用途和许可文件位置 |
| docs/TERMINAL-PREDICTIVE-ECHO.md | 新增 | 用户可理解的效果、范围、开关和限制 |

不预先修改打包脚本、全局 CSS、通用偏好存储、SSH、流控或协议。只有具体验证证明必需时，才把相关最小改动补入计划。

测试用 ANSI 样本放在 `apps/desktop/test/fixtures/terminal-echo/`，只保留固定人工样例或已清理的必要片段，不保存真实账号或用户原始终端记录。

## 2. 任务 1：先验证真实终端适用范围

**产物：** `../output/terminal-predictive-echo/p0/` 内的可复现页面、脚本、结果和结论。此阶段不改产品组件和默认设置。

- [ ] 核对 Node 24、xterm 6.0.0 和候选插件 0.4.2；归档完整实验页面及资源，不再依赖散落在 tmp 中的隐式文件。
- [ ] 先重跑上一轮隔离脚本，确认已知问题仍成立：

```powershell
node ../output/terminal-predictive-echo/review-2026-11-02/verify-addon.mjs
```

预期观察值：proposed API 关闭时 getter 抛错；开启后 widthMethod 为 undefined；背景解析能解除 anchor hold；插件没有 scroll 订阅；refreshFont 不更新旧 span。它们是现状证据，不是功能通过证明。

- [ ] 在隔离页面使用真实键盘→xterm onData，并用受控延迟回声连接预测器。测试 50/150/300ms、合并/拆分 ANSI、无后续输出、持续状态刷新及中途光标移动。
- [ ] 用当前部署的官方 CLI 确认正常 composer、菜单、审批、登录、输入法提交、多行输入和状态刷新的实际画面及光标位置。只使用固定测试文本，观察当前版本；不修改 CLI，也不记录凭据。
- [ ] 提取最小 ANSI 样例，逐条加明确断言：允许预测的区域和坐标、应当禁用的模式、最终真实文本。不得把单个 `^> ` 或 `^❯ ` 正则当作全部语义判断。
- [ ] 记录两个独立结果：ASCII 末尾输入是否稳定；中文单字及词组提交是否稳定。不能拿英文通过代替中文通过。

**通过条件：**

- 当前 CLI 有可复现的普通 composer 识别规则，组合输入区边界、光标位置、屏幕状态等证据；同样带提示符的菜单/输出样例不能误判。
- 现插件能在该区域内稳定预测；背景输出、控制键、行移动后能够保守退回远端显示。
- 登录/审批/未知画面不显示本地预测文字；输入发送无损。
- 普通输入和中文提交的有效预测覆盖率分别可测；无法识别的情况明确记录为不预测。

**未通过的处理：** 若无法识别输入区，或现插件无法稳定对账，停在验证分支，不增加可见的生产开关。保留最小复现并说明具体失败，再比较维护预测实现或增加服务端状态信号的代价。不得用更长 TTL、更多黑名单或“先全面开启”掩盖失败。

任务 1 会产出实际识别规则和回归样本；本计划不凭空编造该规则。只有此条件通过，才执行后续任务。

## 3. 任务 2：锁依赖并先建立输入约束测试

**文件：** package.json、package-lock.json、terminalPrediction.ts、terminal-prediction.test.ts。

- [ ] 在执行分支中添加唯一运行依赖：

```powershell
npm install --workspace @cc-desk-tunnel/desktop --save-exact xterm-zerolag-input@0.4.2
```

核对锁文件没有无关依赖升级；保持现有 xterm 版本。若 npm 重写大量无关内容，查明原因，不直接接受。

- [ ] 先添加表驱动测试，再实现最小输入分类。采用以下明确合同；来源由任务 3 的事件处理提供，不从字符长度猜测：

```ts
export type InputOrigin = 'key' | 'ime' | 'paste' | 'unknown';
export type PredictionInput =
  | { kind: 'text'; text: string }
  | { kind: 'backspace' }
  | { kind: 'clear' };

export function classifyTerminalInput(
  data: string,
  origin: InputOrigin,
): PredictionInput {
  if (origin === 'paste' || origin === 'unknown') return { kind: 'clear' };
  if (origin === 'key' && data === '\x7f') return { kind: 'backspace' };
  const chars = Array.from(data);
  if (!chars.length || chars.length > 32) return { kind: 'clear' };
  if (origin === 'key' && chars.length !== 1) return { kind: 'clear' };
  if (!/^[\x20-\x7e\u4e00-\u9fff，。！？：；（）【】《》、]+$/u.test(data))
    return { kind: 'clear' };
  if (data.includes('/') || data.includes('@')) return { kind: 'clear' };
  return { kind: 'text', text: data };
}
```

上述字符白名单必须在任务 1 中核对宽度；有差异则缩小白名单并更新测试。分类允许不代表一定绘制：后续还要验证输入区、剩余格数和待确认上限。整段放不下时整段不预测，原文仍完整发送。

测试例子：

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTerminalInput } from '../src/terminalPrediction.ts';

test('typing, IME commit and paste have different prediction rules', () => {
  assert.deepEqual(classifyTerminalInput('a', 'key'), { kind: 'text', text: 'a' });
  assert.deepEqual(classifyTerminalInput('中文', 'ime'), { kind: 'text', text: '中文' });
  assert.deepEqual(classifyTerminalInput('a', 'paste'), { kind: 'clear' });
  assert.deepEqual(classifyTerminalInput('中', 'unknown'), { kind: 'clear' });
  assert.deepEqual(classifyTerminalInput('😀', 'key'), { kind: 'clear' });
  assert.deepEqual(classifyTerminalInput('\x1b[A', 'key'), { kind: 'clear' });
  assert.deepEqual(classifyTerminalInput('/', 'key'), { kind: 'clear' });
  assert.deepEqual(classifyTerminalInput('@', 'key'), { kind: 'clear' });
  assert.deepEqual(classifyTerminalInput('\x7f', 'key'), { kind: 'backspace' });
});
```

- [ ] 执行 `node --test apps/desktop/test-main/terminal-prediction.test.ts`；先确认新增行为失败，再实现并确认通过。
- [ ] 记录独立提交，内容限依赖、纯输入规则和对应测试；功能此时仍未启用。

## 4. 任务 3：实现最小接入模块

**文件：** terminalPrediction.ts、terminal-prediction.test.ts、测试 ANSI 样例。

模块固定只负责显示预测；由 NativeTerminal.tsx 提供运行状态。接口限定为：

```ts
import type { Terminal } from '@xterm/xterm';

export type PredictionContext = {
  running: boolean;
  visible: boolean;
  connected: boolean;
  closing: boolean;
};
export type TerminalPrediction = {
  beforeInput(data: string): void;
  clear(): void;
  refresh(): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
};
export function createTerminalPrediction(
  terminal: Terminal,
  host: HTMLElement,
  context: () => PredictionContext,
): TerminalPrediction;
```

这是接入合同，实际实现需在同文件提供；不增加可替换引擎注册、网络层或通用事件总线。

- [ ] 为任务 1 的允许/拒绝样例先写测试。普通 composer 行尾可预测；状态栏、菜单、审批、备用屏幕、上滚、失焦、组字中、断线和未知模式都拒绝。
- [ ] 实现事件来源跟踪：监听实际 terminal.textarea 的 composition/paste/键盘事件；输入法提交只使用 xterm 最终 onData 原文，绝不根据 compositionend 再发送一遍文本。compositionend 后的异步 onData 必须有测试覆盖；无法归因的文本走 unknown。
- [ ] 两个现有 terminal.paste() 调用点也明确标记为粘贴；不能假定 bracketed paste 总是开启，单字符粘贴同样禁止预测。
- [ ] 将任务 1 验证过的 composer 检测规则放入模块。控制键、光标移动或未知重绘清空并失效；只有新的有效 composer 快照及相应编辑结果满足规则时才恢复。插件内部 anchor hold 的解除本身不作为恢复依据。
- [ ] 只在已经验证的行尾区域画字。先检查整段字符宽度、右边缘至少 4 格、现有待确认数量加本段不超过 32；单次短 IME 提交按字符画出。任何一个字符被插件拒绝时清空该轮预测并回退。
- [ ] 只预测删除未确认字符。删除已经回显的文字、行中插入、换行及组合字符编辑走原显示路径。
- [ ] 初始设置 TTL 800ms、maxPending 32、edgeMarginCells 4，作为限制值，不作为“准确确认”的证明。不增加设置页中的技术参数。
- [ ] 插件仅在开启时加载。利用 xterm 的可写 `terminal.options.allowProposedApi` 在该实例上启用；关闭时清理并恢复原值，不重启 terminal。初始化失败回到原显示路径。
- [ ] 订阅并主动处理 onScroll、onResize、窗口失焦与必要模式变化；已有 span 必须立即清空，不等 TTL。字体/主题/DPI 变化采用“清空→刷新度量”的顺序。
- [ ] 异常时尝试 dispose 并移除该模块持有的 overlay，当前实例停止预测；不重建远端终端，不影响输入。所有监听和 timer 在 dispose 释放，重复 dispose 不报错。
- [ ] 运行同一组 Node 测试。至少含：源判断、门控恢复、背景输出不能独自解锁、边缘限制、字组整体降级、字体/滚动清理、初始化和输入预测故障。

测试替身只验证模块状态和调用；真实坐标/渲染留给任务 6。不要把替身通过写成真实 TUI 已通过。

## 5. 任务 4：接入 NativeTerminal 的现有生命周期

**文件：** NativeTerminal.tsx、terminal-window.fixture.tsx。

- [ ] 保留当前 Terminal、FitAddon、链接、ACK、分片和连接状态代码。terminal.open() 后创建接入模块，读取真实 host.ownerDocument/defaultView，兼容独立窗口。
- [ ] 在现有 onData 校验通过后、原分片发送循环之前插入如下隔离调用：

```ts
try {
  prediction.beforeInput(data);
} catch {
  try { prediction.dispose(); } catch {}
}
// 下方继续现有 terminal.input 分片发送循环。
// 不 return，不 await，不根据预测返回值判断是否发送。
```

- [ ] 用测试注入预测失败，核对发出的 terminal.input 数据完全相同，输入只发一次；错误降级也须清除预测层。
- [ ] 接入 status、accept、关闭、断线、隐藏标签和重试：先清空预测，再按原状态机继续处理；不改变终端归属或恢复行为。
- [ ] 字号 effect、repaint、窗口/DPI resize 使用 refresh；弹窗出现时立即清空。优先使用已有应用状态；若没有统一弹窗状态，只在该终端的 ownerDocument.body 对 dialog 的相关属性/节点做窄范围观察，不逐键扫描整页。
- [ ] 粘贴入口标记来源，但保留原有多行粘贴和控制字符校验；卸载时先释放预测资源，再 terminal.dispose()。
- [ ] 通过 fixture 验证切字号、切开关、隐藏/恢复不会新增 terminal.open/terminal.close 请求。

## 6. 任务 5：一个本机设置及许可

**文件：** prefs.ts、SettingsPage.tsx、settings-pages.spec.ts、NOTICE、新增第三方许可。

偏好只添加以下三处，不重构整个存储：

```ts
// Prefs:
terminalPredictiveEcho: boolean;
// defaults:
terminalPredictiveEcho: false,
// read() 的返回对象:
terminalPredictiveEcho: saved.terminalPredictiveEcho === true,
```

- [ ] 测试旧配置、缺失字段、非法值都读为 false；只有 true 才开启。
- [ ] 在“设置→常规”的现有外观相关卡片附近复用 Row/Switch；关键词加入“终端 预测 回显”。文案：

```text
终端输入预测（实验性）
先在本机显示部分输入，减少远程终端打字的等待感。
菜单和复杂编辑仍以远端显示为准；出现闪烁时可关闭。
```

- [ ] 沿用现有 prefs 共享机制；开关变化只调整预测模块，当前终端进程保持原样。持久化失败不能产生无提示的未处理异常；若现有 setPrefs 会抛错，在新增开关的调用边界处理，不顺带改写整个偏好系统。
- [ ] 从实际安装的插件复制完整 MIT LICENSE 到 public/third-party，NOTICE 标明来源、版本及用途。保留全部既有许可。
- [ ] 补设置测试：默认关、开启保存、重载保留、关闭即时清理、主窗口与独立终端同步、存储失败可见反馈。
- [ ] 单独提交设置、许可及相关测试。

## 7. 任务 6：集成验证，用结果决定是否交付

**文件：** terminal-predictive-echo.spec.ts、terminal-window.fixture.tsx、terminal-window.spec.ts。

- [ ] 在测试夹具增加可控回声队列：延迟、拆分、合并、背景刷屏、错配、停止输出。记录输入帧和最终真实 buffer，测试接口不进入正式构建。
- [ ] 第一组确认显示和发送：先出现 overlay，真实 buffer 尚未改变；回声到达后 overlay 消失，buffer 和发送内容均恰好一份。
- [ ] 第二组确认复杂顺序：输入→退格→立刻重输、Enter/Esc→背景刷新→继续输入、IME 提交异步到达、粘贴恰好一个字符、未开启 bracketed paste、pending 已满和超时后继续输入。
- [ ] 第三组确认布局和生命周期：上滚、焦点离开、应用弹窗、字号改变但行列不变、主题切换、标签隐藏、断线、关闭、快速重开。检查无旧 span、监听泄漏和跨实例残留。
- [ ] 第四组运行真实 Electron，包括 Windows 原生中文输入法手测。浏览器合成 composition 事件只能测试分支，不可替代原生输入法验证。
- [ ] 将测试环境、CLI/客户端版本、延迟、样本数及实际结果写入验证记录。样例只使用人工测试文字。

**拟定验收目标（执行前固定，不在失败后放宽）：**

| 项目 | 标准 |
| --- | --- |
| 正确性 | 所有测试中发送内容、顺序、次数与关闭预测一致；无丢字、重复发送或自动重发 |
| 最终画面 | 回声到达后与远端预期完全一致；预测期间真实 buffer 不变 |
| 未知/敏感界面 | 测试矩阵内零次预测明文；任一误判即停止交付 |
| 普通追加输入 | 200ms 模拟回显延迟、前台空闲桌面下，至少 100 个合格输入样本的本地预测插入延迟 P95 ≤16ms；另验证下一个可用绘制帧可见 |
| 中文 | 单字和词组提交分别测试，每组至少 100 次；源识别正确、无双重提交；合格提交中至少 95% 能预测 |
| 普通英文 | 合格输入中至少 95% 能预测；遇到不合格场景正确回退，不计入覆盖率分母 |
| 视觉稳定性 | 固定正常输入样本内零错位；未知状态不靠 TTL 残影撑过去；真实链路手测若反复可见回滚，暂不交付 |
| 性能 | 不出现新增长任务；每次扫描限屏幕/输入区，不扫描整个 scrollback 或历史 |
| 故障降级 | 初始化/绘制/清理失败不阻断发送；关闭开关后清理完成且进程不重启 |

“合格输入”必须在任务 1 提前定义：已识别的普通 composer 行尾、已支持字符、容量/边缘范围内、非粘贴/组字/菜单。不能通过事后缩小分母掩盖正常输入无收益。该标准是有限场景预测的验收，不宣称所有 TUI 状态的数学保证。

**建议执行命令：** 在源码根目录、Node 24 下，顺序运行。

```powershell
node --test apps/desktop/test-main/terminal-prediction.test.ts
npm run typecheck
npm run test:ui -- apps/desktop/test/terminal-predictive-echo.spec.ts apps/desktop/test/native-terminal.spec.ts apps/desktop/test/terminal-window.spec.ts apps/desktop/test/terminal-workspace.spec.ts apps/desktop/test/terminal-close.spec.ts apps/desktop/test/terminal-status.spec.ts apps/desktop/test/settings-pages.spec.ts
npm test
npm run format:check
npm run check
git diff --check
```

预期：新增测试无失败；类型、格式、构建和边界检查通过。UI 脚本自带 prebuild，会构建客户端。若执行机器需要已安装 Chrome，可在当前进程设置 PLAYWRIGHT_CHANNEL=chrome，勿修改项目默认配置。

npm run check 读取 Git 索引：执行前先审查差异，再只暂存本任务文件；未暂存的新文件不能当作已经受它检查。

全量测试若失败，应先确认同一基线是否复现；记录原有失败及影响。不得把新回归归类为“历史问题”，也不为通过测试修改无关发布清单。

## 8. 任务 7：交付说明与回滚

- [ ] 新增 docs/TERMINAL-PREDICTIVE-ECHO.md，说明支持场景、中文边界、开关位置、依赖版本、已验证系统和未覆盖环境。
- [ ] 验证正常客户端构建和已有服务端 Web 构建路径均包含插件代码及第三方许可；优先复用当前构建，不为查一个文件重新运行整个发布流程。
- [ ] 检查 git diff：产品改动仅限文件表中的职责；不新增网络/模型入口，不更改协议、服务端流控或官方 CLI。
- [ ] 交付源码和验证记录，默认仍为 false。构建安装包、发布、远端部署按后续交付任务处理，本计划不顺带执行。
- [ ] 回滚为关闭现有开关并释放预测模块；若删除功能，按任务提交撤销客户端相关改动。无需数据库迁移、服务端回退或账号操作。

## 9. 顺序、工作量及完成判据

顺序为：**真实兼容性验证 → 输入与接入模块 → 生命周期 → 开关与许可 → 中英文/真实窗口验收 → 交付**。这些步骤存在依赖，不为并行而拆分。

| 阶段 | 估计 | 结束时必须有 |
| --- | --- | --- |
| 任务 1 | 0.5–1.5 人日 | 真实样例、明确门控规则、可行/不可行结论 |
| 任务 2–5 | 1.5–3 人日 | 最小接入、默认关闭、输入一致性和生命周期测试 |
| 任务 6–7 | 1–2 人日 | 中文/真实 Electron 证据、回归结果、交付说明 |

以上为任务 1 通过后的规划参考，不是固定工期承诺；如果需要改插件核心或新增服务端信号，另行估计范围。仅写完代码、英文演示成功或插件不报错，都不等于本功能完成。

本次交付完成判据：实现与实际检查结果均可复核；不能用计划复选框替代测试结果。

## 10. 执行记录（2026-11-03）

源码在 `codex/terminal-predictive-echo` 隔离分支实现，默认关闭。任务 2–5 的代码、输入来源、编辑屏障、设置与许可均完成，相关回归及真实 Electron 独立窗口验证完成。详细结果见 [功能与验证记录](../../TERMINAL-PREDICTIVE-ECHO.md)。

根据用户回传的两次 Linux 2.1.295 采样作了必要修正：普通编辑框本身使用备用屏幕，不能按原假设全面禁用；改为识别已验证的底部单行编辑框结构和实际反色光标。Linux 的光标位置正确，Windows ConPTY 2.1.286 的偏移反例不适用该目标。第二次采样在一次性容器用空内存策略目录完成本地模拟回答，未改变生产审核策略。

物理 Windows 输入法及未知审批界面的完整人工矩阵没有冒称通过；当前按有限实验性范围交付源码。构建、发布安装包及生产部署继续遵循任务 7 的独立交付边界。
