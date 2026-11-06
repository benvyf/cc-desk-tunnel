import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';

// What waits on the user stands where the input box stood (ApprovalDock.tsx): a permission, Claude's questions one
// at a time, a plan to approve. The transcript keeps the call's line and says where it is answered.
const url = 'ws://127.0.0.1:18899/ws';
const connectionId = randomUUID();
const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
function session(title: string, waiting: 'approval' | 'question'): Session {
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
    activeRun: { id: randomUUID(), status: 'awaiting_approval', connectionId, waiting },
  } as Session;
}
const histories = new Map<string, object[]>();
const approvals = new Map<string, string>();
function waitOn(target: Session, name: string, input: object, before: object[] = []) {
  const approvalId = randomUUID();
  approvals.set(target.id, approvalId);
  histories.set(
    target.id,
    [
      { type: 'message.user', messageId: randomUUID(), text: target.title, scenario: 'chat' },
      { type: 'run.status', status: 'running', connectionId },
      ...before,
      {
        type: 'tool.requested',
        toolId: 't1',
        name,
        input: JSON.stringify(input),
        target: 'Windows',
      },
      { type: 'approval.requested', approvalId, toolId: 't1' },
      {
        type: 'run.status',
        status: 'awaiting_approval',
        connectionId,
        waiting: name === 'AskUserQuestion' ? 'question' : 'approval',
      },
    ].map((payload, index) => ({
      sessionId: target.id,
      runId: target.activeRun!.id,
      sequence: index + 1,
      createdAt: at(120 - index),
      payload,
    })),
  );
}
const command = session('运行测试', 'approval');
waitOn(command, 'Bash', { command: 'npm test -- --run src/auth', description: '运行登录模块测试' });
const question = session('选个方案', 'question');
waitOn(question, 'AskUserQuestion', {
  questions: [
    {
      question: '登录状态放在哪里？',
      header: '方案',
      multiSelect: false,
      options: [
        { label: 'React Context', description: '改动最小，适合现在的规模' },
        { label: 'Zustand', description: '多一个依赖，跨组件订阅更省事' },
      ],
    },
    {
      question: '要顺手补测试吗？',
      multiSelect: true,
      options: [{ label: '单元测试' }, { label: '端到端测试' }],
    },
  ],
});
const plan = session('先出计划', 'approval');
waitOn(plan, 'ExitPlanMode', {
  plan: '## 改造登录模块\n\n1. 把 `AuthStore` 换成 `useAuth` hook\n2. 迁移三个调用方\n3. 跑一遍测试',
});
const sessions = [command, question, plan];

async function connect(page: Page) {
  const commands: Record<string, unknown>[] = [];
  await page.routeWebSocket(url, (route) => {
    const send = (value: object) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      commands.push(message);
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId,
          adapter: 'claude-code',
          sessions,
        });
      if (message.type === 'session.subscribe') {
        const events = histories.get(message.sessionId) ?? [];
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session: sessions.find((item) => item.id === message.sessionId),
          mode: 'replace',
          firstSequence: events.length ? 1 : 0,
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      }
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page.getByLabel('服务凭据', { exact: true }).fill('approval-dock-token-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  return commands;
}
const open = (page: Page, title: string) =>
  page.locator('.session-row').filter({ hasText: title }).locator('.session-select').click();
const replies = (commands: Record<string, unknown>[]) =>
  commands.filter((item) => item.type === 'approval.reply');

test('a permission is asked where the input box stood, and the transcript keeps one line', async ({
  page,
}) => {
  const commands = await connect(page);
  await open(page, command.title);
  const dock = page.getByRole('region', { name: '需要你的许可' });
  await expect(dock).toBeVisible();
  await expect(dock.locator('.approval-title')).toHaveText('允许运行这条命令？');
  await expect(dock.locator('.tool-input-note')).toHaveText('运行登录模块测试');
  await expect(dock.locator('.tool-command')).toHaveText('npm test -- --run src/auth');
  // The box steps aside while the dock asks; nothing in the transcript offers the buttons a second time.
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeHidden();
  await expect(page.locator('.transcript .approval-actions')).toHaveCount(0);
  await expect(page.locator('.transcript .tool.docked .tool-await')).toHaveText('在下方处理');
  await dock.getByRole('button', { name: '允许', exact: true }).click();
  await expect.poll(() => replies(commands)).toHaveLength(1);
  expect(replies(commands)[0]).toMatchObject({
    sessionId: command.id,
    approvalId: approvals.get(command.id),
    allowed: true,
  });
  // Pressed once, the dock waits for the service and takes no second answer.
  await expect(dock.getByRole('button', { name: '允许', exact: true })).toBeDisabled();
});

test("Claude's questions come one at a time, answered by number and Enter", async ({ page }) => {
  const commands = await connect(page);
  await open(page, question.title);
  const dock = page.getByRole('form', { name: 'Claude 的提问' });
  await expect(dock).toBeVisible();
  await expect(dock.locator('.approval-dock-pager')).toContainText('1 / 2');
  await expect(dock.locator('legend')).toContainText('登录状态放在哪里？');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeHidden();
  await expect(page.locator('.transcript .tool.docked .tool-await')).toHaveText('在下方回答');
  // Keys answer within the dock: a number picks, and a single choice turns the page by itself.
  await dock.locator('legend').click();
  await page.keyboard.press('2');
  await expect(dock.getByRole('radio', { name: 'Zustand', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dock.locator('.approval-dock-pager')).toContainText('2 / 2');
  await expect(dock.locator('legend')).toContainText('要顺手补测试吗？');
  const submit = dock.getByRole('button', { name: '提交回答', exact: true });
  await expect(submit).toBeDisabled();
  await page.keyboard.press('1');
  await dock.getByLabel('其他回答：要顺手补测试吗？').fill('只补登录相关的');
  // ← goes back without losing what was chosen.
  await dock.getByRole('button', { name: '上一个问题', exact: true }).click();
  await expect(dock.getByRole('radio', { name: 'Zustand', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await dock.press('ArrowRight');
  await expect(dock.locator('.approval-dock-pager')).toContainText('2 / 2');
  await page.keyboard.press('Enter');
  await expect.poll(() => replies(commands)).toHaveLength(1);
  expect(replies(commands)[0]).toMatchObject({
    approvalId: approvals.get(question.id),
    allowed: true,
    answers: {
      '登录状态放在哪里？': 'Zustand',
      '要顺手补测试吗？': '单元测试, 只补登录相关的',
    },
  });
});

test('a question can be left unanswered', async ({ page }) => {
  const commands = await connect(page);
  await open(page, question.title);
  await page
    .getByRole('form', { name: 'Claude 的提问' })
    .getByRole('button', { name: '不回答', exact: true })
    .click();
  await expect.poll(() => replies(commands)).toHaveLength(1);
  expect(replies(commands)[0]).toMatchObject({ allowed: false });
  expect(replies(commands)[0]).not.toHaveProperty('answers');
});

test('a plan is read in the dock and approved or sent back for more planning', async ({ page }) => {
  const commands = await connect(page);
  await open(page, plan.title);
  const dock = page.getByRole('region', { name: '计划审批' });
  await expect(dock).toBeVisible();
  await expect(dock.getByRole('heading', { name: '改造登录模块' })).toBeVisible();
  await expect(dock.locator('.approval-dock-plan li')).toHaveCount(3);
  await expect(page.locator('.transcript .tool.docked')).toContainText('等待批准计划');
  await expect(page.locator('.transcript .tool.docked')).toContainText('改造登录模块');
  await dock.getByRole('button', { name: '继续规划', exact: true }).click();
  await expect.poll(() => replies(commands)).toHaveLength(1);
  expect(replies(commands)[0]).toMatchObject({ allowed: false });
});
