import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';

// The conversation says a run's state once (spec §5.9) and shows each call's input in the shape its tool reads
// (spec §5.8): a command, a diff, a path, a search; only an unknown tool shows its fields.
const url = 'ws://127.0.0.1:18898/ws';
const connectionId = randomUUID();
const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
function session(title: string, run: Partial<NonNullable<Session['activeRun']>> | null): Session {
  return {
    id: randomUUID(),
    title,
    autoTitle: false,
    projectPath: 'D:\\work\\api',
    permissionMode: 'default',
    model: null,
    effort: null,
    createdAt: at(600),
    updatedAt: at(5),
    activeRun: run ? { id: randomUUID(), status: 'running', connectionId, ...run } : null,
  } as Session;
}
const waiting = session('等待审批的会话', { status: 'awaiting_approval', waiting: 'approval' });
const finished = session('做完的会话', null);
const failed = session('失败的会话', null);
const histories = new Map<string, object[]>();
function history(target: Session, runId: string, payloads: object[]) {
  histories.set(
    target.id,
    payloads.map((payload, index) => ({
      sessionId: target.id,
      runId,
      sequence: index + 1,
      createdAt: at(120 - index),
      payload,
    })),
  );
}
const tool = (toolId: string, name: string, input: object) => ({
  type: 'tool.requested',
  toolId,
  name,
  input: JSON.stringify(input),
  target: 'Windows',
});
const result = (toolId: string, output: string, exitCode: number | null = null) => ({
  type: 'tool.result',
  toolId,
  status: exitCode ? 'failed' : 'completed',
  output,
  exitCode,
});
const ask = (text: string) => ({
  type: 'message.user',
  messageId: randomUUID(),
  text,
  scenario: 'chat',
});
history(waiting, waiting.activeRun!.id, [
  ask('把登录改成 hooks'),
  { type: 'run.status', status: 'running', connectionId },
  tool('e1', 'Edit', {
    file_path: 'D:\\work\\api\\src\\auth.ts',
    old_string: 'class AuthStore {\n  user = null;\n}',
    new_string: 'export function useAuth() {\n  const [user, setUser] = useState(null);\n}',
  }),
  result('e1', 'The file has been updated.'),
  tool('b1', 'Bash', { command: 'npm test -- --run src/auth', description: '运行登录模块测试' }),
  { type: 'approval.requested', approvalId: randomUUID(), toolId: 'b1' },
  { type: 'run.status', status: 'awaiting_approval', connectionId, waiting: 'approval' },
]);
const finishedRun = randomUUID();
history(finished, finishedRun, [
  ask('查一下中间件'),
  { type: 'run.status', status: 'running', connectionId },
  tool('g1', 'Grep', { pattern: 'middleware', path: 'D:\\work\\api\\gateway', '-i': true }),
  result('g1', 'gateway/index.ts:12'),
  tool('r1', 'Read', { file_path: 'D:\\work\\api\\gateway\\index.ts', offset: 10, limit: 20 }),
  result('r1', 'export const app = …'),
  tool('w1', 'Write', { file_path: 'D:\\work\\api\\gateway\\limiter.ts', content: 'a\nb' }),
  result('w1', 'File created successfully'),
  tool('l1', 'Bash', { command: 'npm run lint' }),
  result('l1', "3:7  error  'rate' is defined but never used", 1),
  tool('x1', 'mcp__docs__lookup', { topic: 'limits', depth: 2 }),
  result('x1', 'ok'),
  { type: 'text.delta', messageId: randomUUID(), text: '做完了。' },
  { type: 'run.status', status: 'completed', connectionId },
]);
const failedRun = randomUUID();
history(failed, failedRun, [
  ask('首页为什么慢'),
  { type: 'run.status', status: 'running', connectionId },
  { type: 'text.delta', messageId: randomUUID(), text: '我先构建一次。' },
  { type: 'run.error', code: 'native_exit', message: 'Claude Code 意外退出（退出码 1）。' },
  { type: 'run.status', status: 'failed', connectionId },
]);
const sessions = [waiting, finished, failed];

async function connect(page: Page) {
  const commands: { type: string; sessionId?: string }[] = [];
  await page.routeWebSocket(url, (route) => {
    const send = (value: object) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 'device') return;
      if (command.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId,
          adapter: 'claude-code',
          sessions,
        });
      if (command.type === 'session.subscribe') {
        const events = histories.get(command.sessionId) ?? [];
        send({
          type: 'session.snapshot',
          requestId: command.requestId,
          session: sessions.find((item) => item.id === command.sessionId),
          mode: 'replace',
          firstSequence: events.length ? 1 : 0,
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      }
      send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.goto('/');
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page.getByLabel('服务凭据', { exact: true }).fill('conversation-status-token-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  return commands;
}
const open = (page: Page, title: string) =>
  page.locator('.session-row').filter({ hasText: title }).locator('.session-select').click();
async function openAll(page: Page) {
  for (const selector of ['.turn-process', '.work', '.tool'])
    while (await page.locator(`${selector}:not([open]) > summary`).count())
      await page.locator(`${selector}:not([open]) > summary`).first().click();
}

test('an approval is asked once, in words, over the command it allows', async ({ page }) => {
  await connect(page);
  await open(page, '等待审批的会话');
  const card = page.locator('.tool[open]').filter({ has: page.locator('.approval-actions') });
  await expect(card.locator('.approval-title')).toHaveText('允许运行这条命令？');
  await expect(card.locator('.tool-section-head').first()).toContainText('命令');
  await expect(card.locator('.tool-input-note')).toHaveText('运行登录模块测试');
  await expect(card.locator('.tool-command')).toHaveText('npm test -- --run src/auth');
  await expect(card.getByRole('button', { name: '允许', exact: true })).toBeVisible();
  // The card is the state: no line at the end of the conversation and none above the input box repeats it.
  await expect(page.locator('.transcript > .run-indicator')).toHaveCount(0);
  await expect(page.getByLabel('当前任务状态', { exact: true })).toHaveCount(0);
  await expect(page.getByText('等待你审批')).toHaveCount(0);
  // The edit before it shows its change as a diff, and its line counts what the diff shows.
  const edit = page.locator('.tool').filter({ hasText: 'auth.ts' }).first();
  await expect(edit.locator('.tool-diff')).toHaveText('+2−2');
  await edit.locator('summary').click();
  const diff = edit.locator('.tool-diff-view > span');
  await expect(diff).toHaveText([
    '−class AuthStore {',
    '−  user = null;',
    '+export function useAuth() {',
    '+  const [user, setUser] = useState(null);',
    ' }',
  ]);
  await expect(diff.nth(0)).toHaveClass('removed');
  await expect(diff.nth(2)).toHaveClass('added');
  await expect(diff.nth(4)).not.toHaveClass(/added|removed/);
  await expect(edit.locator('.tool-input-path')).toHaveText('D:\\work\\api\\src\\auth.ts');
  await expect(edit.locator('pre', { hasText: '"old_string"' })).toHaveCount(0);
});

test('each tool shows its input in its own shape; an unknown one shows its fields indented', async ({
  page,
}) => {
  await connect(page);
  await open(page, '做完的会话');
  await openAll(page);
  const call = (text: string) => page.locator('.tool').filter({ hasText: text }).first();
  const grep = call('middleware');
  await expect(grep.locator('.tool-command')).toHaveText('middleware');
  await expect(grep.locator('.tool-input-meta')).toHaveText(
    '位置 D:\\work\\api\\gateway · 忽略大小写',
  );
  await expect(call('已读取').locator('.tool-input-path')).toHaveText(
    'D:\\work\\api\\gateway\\index.ts第 10–29 行',
  );
  const write = call('limiter.ts');
  await expect(write.locator('.tool-section-head').first()).toContainText('写入');
  await expect(write.locator('.tool-diff-view > .added')).toHaveCount(2);
  const lint = call('npm run lint');
  await expect(lint.locator('.tool-results .tool-section-head')).toContainText('退出码 1');
  await expect(lint.locator('.tool-output')).toHaveText(
    "3:7  error  'rate' is defined but never used",
  );
  const other = call('mcp__docs__lookup');
  await expect(other.locator('.tool-input-json')).toHaveText(
    JSON.stringify({ topic: 'limits', depth: 2 }, null, 2),
  );
  // Copy sits beside each heading and copies what is shown: the command, not the call's JSON.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await lint.locator('.tool-input').hover();
  await lint.getByRole('button', { name: '复制工具输入', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm run lint');
  // Finished, nothing says so.
  await expect(page.locator('.transcript > .run-indicator')).toHaveCount(0);
  await expect(page.getByText('本轮已完成')).toHaveCount(0);
});

test('a failure is one red bar where the turn ends, with the way to go on in it', async ({
  page,
}) => {
  const commands = await connect(page);
  await open(page, '失败的会话');
  const bar = page.locator('.run-notice.failed');
  await expect(bar).toHaveCount(1);
  await expect(bar).toContainText('Claude Code 意外退出（退出码 1）。');
  await expect(page.getByText('Claude Code 意外退出（退出码 1）。', { exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByLabel('当前任务状态', { exact: true })).toHaveCount(0);
  const resume = bar.getByRole('button', { name: '继续上一轮', exact: true });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect.poll(() => commands.some((command) => command.type === 'run.continue')).toBe(true);
});
