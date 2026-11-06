import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';

// What waits on the user stands where the input box stood (ApprovalDock.tsx): a permission, Claude's questions one
// at a time, a plan to approve. The transcript keeps the call's line and says where it is answered; the dock can
// fold into a bar over the input box for a message first.
const url = 'ws://127.0.0.1:18899/ws';
const connectionId = randomUUID();
const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
function session(title: string, waiting?: 'approval' | 'question'): Session {
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
    activeRun: {
      id: randomUUID(),
      status: waiting ? 'awaiting_approval' : 'running',
      connectionId,
      ...(waiting ? { waiting } : {}),
    },
  } as Session;
}
const histories = new Map<string, object[]>();
const approvals = new Map<string, string[]>();
const record = (target: Session, payloads: object[]) =>
  histories.set(
    target.id,
    payloads.map((payload, index) => ({
      sessionId: target.id,
      runId: target.activeRun!.id,
      sequence: index + 1,
      createdAt: at(120 - index),
      payload,
    })),
  );
const asks = (name: string, input: object, toolId = 't1') => {
  const approvalId = randomUUID();
  return {
    approvalId,
    events: [
      { type: 'tool.requested', toolId, name, input: JSON.stringify(input), target: 'Windows' },
      { type: 'approval.requested', approvalId, toolId },
    ],
  };
};
function waitOn(target: Session, calls: { name: string; input: object }[]) {
  const made = calls.map((call, index) => asks(call.name, call.input, `t${index + 1}`));
  approvals.set(
    target.id,
    made.map((call) => call.approvalId),
  );
  record(target, [
    { type: 'message.user', messageId: randomUUID(), text: target.title, scenario: 'chat' },
    { type: 'run.status', status: 'running', connectionId },
    ...made.flatMap((call) => call.events),
    {
      type: 'run.status',
      status: 'awaiting_approval',
      connectionId,
      waiting: calls[0].name === 'AskUserQuestion' ? 'question' : 'approval',
    },
  ]);
}
const bash = (command: string) => ({
  name: 'Bash',
  input: { command, description: '运行登录模块测试' },
});
const choose = {
  questions: [
    {
      question: '登录状态放在哪里？',
      header: '方案',
      multiSelect: false,
      options: [
        { label: 'React Context', description: '改动最小，适合现在的规模' },
        {
          label: 'Zustand',
          description: '多一个依赖，跨组件订阅更省事',
          preview: '```ts\ncreate((set) => ({}))\n```',
        },
      ],
    },
    {
      question: '要顺手补测试吗？',
      multiSelect: true,
      options: [{ label: '单元测试' }, { label: '端到端测试' }],
    },
  ],
};
const command = session('运行测试', 'approval');
waitOn(command, [bash('npm test -- --run src/auth')]);
const two = session('两条命令', 'approval');
waitOn(two, [bash('npm run lint'), bash('npm test')]);
const question = session('选个方案', 'question');
waitOn(question, [{ name: 'AskUserQuestion', input: choose }]);
const words = session('自己写的回答', 'question');
waitOn(words, [
  {
    name: 'AskUserQuestion',
    input: { questions: [{ question: '新模块叫什么名字？', header: '命名', kind: 'text' }] },
  },
]);
const plan = session('先出计划', 'approval');
waitOn(plan, [
  {
    name: 'ExitPlanMode',
    input: {
      plan: '## 改造登录模块\n\n1. 把 `AuthStore` 换成 `useAuth` hook\n2. 迁移三个调用方\n3. 跑一遍测试',
    },
  },
]);
const answered = session('已回答的提问');
{
  const call = asks('AskUserQuestion', {
    questions: [
      { question: '登录状态放在哪里？', options: [{ label: 'a' }, { label: 'b' }] },
      { question: '路径？', options: [{ label: 'a' }, { label: 'b' }] },
    ],
  });
  record(answered, [
    { type: 'message.user', messageId: randomUUID(), text: answered.title, scenario: 'chat' },
    { type: 'run.status', status: 'running', connectionId },
    ...call.events,
    { type: 'approval.resolved', approvalId: call.approvalId, allowed: true },
    {
      type: 'tool.result',
      toolId: 't1',
      status: 'completed',
      // As Claude Code words it: pairs joined by ", ", nothing escaped.
      output:
        'The user answered: "登录状态放在哪里？"="叫它 "store" 就好", "路径？"="C:\\dir\\". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
      exitCode: null,
    },
    { type: 'text.delta', messageId: randomUUID(), text: '好。' },
    { type: 'run.status', status: 'completed', connectionId },
  ]);
  (answered as { activeRun: unknown }).activeRun = null;
}
// An answer from an earlier turn, quoted into the input box while a permission waits in this one.
const quoting = session('引用时有审批', 'approval');
{
  const call = asks('Bash', { command: 'npm test' });
  const earlier = randomUUID();
  record(quoting, [
    { type: 'message.user', messageId: randomUUID(), text: '先看看', scenario: 'chat' },
    { type: 'run.status', status: 'running', connectionId },
    { type: 'text.delta', messageId: randomUUID(), text: '登录模块用的是 AuthStore。' },
    { type: 'run.status', status: 'completed', connectionId },
    { type: 'message.user', messageId: earlier, text: '跑一下测试', scenario: 'chat' },
    { type: 'run.status', status: 'running', connectionId },
    ...call.events,
    { type: 'run.status', status: 'awaiting_approval', connectionId, waiting: 'approval' },
  ]);
}
const later = session('稍后提问');
record(later, [
  { type: 'message.user', messageId: randomUUID(), text: later.title, scenario: 'chat' },
  { type: 'run.status', status: 'running', connectionId },
]);
const sessions = [command, two, question, words, plan, answered, quoting, later];

type Mock = {
  commands: Record<string, unknown>[];
  // Says something of a session as the service would, while the page is open.
  push: (target: Session, payload: object) => void;
  refuse: boolean;
};
async function connect(page: Page) {
  const mock: Mock = { commands: [], push: () => {}, refuse: false };
  await page.routeWebSocket(url, (route) => {
    const send = (value: object) => route.send(JSON.stringify(value));
    let sequence = 1000;
    mock.push = (target, payload) =>
      send({
        type: 'session.event',
        event: {
          sessionId: target.id,
          runId: target.activeRun!.id,
          sequence: ++sequence,
          createdAt: new Date().toISOString(),
          payload,
        },
      });
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      mock.commands.push(message);
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
      if (message.type === 'approval.reply' && mock.refuse)
        return send({
          type: 'response',
          requestId: message.requestId,
          ok: false,
          message: '审批已过期',
          code: 'approval_unavailable',
        });
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
  return mock;
}
async function open(page: Page, title: string) {
  // A project lists six sessions until it is asked for all.
  const more = page.getByRole('button', { name: /^显示全部/ });
  if (await more.count()) await more.click();
  await page.locator('.session-row').filter({ hasText: title }).locator('.session-select').click();
}
const replies = (mock: Mock) => mock.commands.filter((item) => item.type === 'approval.reply');
const messageBox = (page: Page) => page.getByRole('textbox', { name: '消息', exact: true });

test('a permission is asked where the input box stood, and the transcript keeps one line', async ({
  page,
}) => {
  const mock = await connect(page);
  await open(page, command.title);
  const dock = page.getByRole('region', { name: '需要你的许可' });
  await expect(dock).toBeVisible();
  await expect(dock.locator('.approval-title')).toHaveText('允许运行这条命令？');
  // The call as the transcript shows it, headed and with its copy button.
  await expect(dock.locator('.tool-section-head')).toContainText('命令');
  await expect(dock.getByRole('button', { name: '复制工具输入', exact: true })).toHaveCount(1);
  await expect(dock.locator('.tool-input-note')).toHaveText('运行登录模块测试');
  await expect(dock.locator('.tool-command')).toHaveText('npm test -- --run src/auth');
  // The box steps aside while the dock asks; nothing in the transcript offers the buttons a second time.
  await expect(messageBox(page)).toBeHidden();
  await expect(page.locator('.transcript .approval-actions')).toHaveCount(0);
  await expect(page.locator('.transcript .tool.docked .tool-await')).toHaveText('在下方处理');
  // Tab from the dock's question reaches the answer before "stop".
  await dock.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(dock.getByRole('button', { name: '拒绝', exact: true })).toBeFocused();
  const allow = dock.getByRole('button', { name: '允许', exact: true });
  await allow.click();
  await expect.poll(() => replies(mock)).toHaveLength(1);
  expect(replies(mock)[0]).toMatchObject({
    sessionId: command.id,
    approvalId: approvals.get(command.id)![0],
    allowed: true,
  });
  // Pressed once, the dock waits for the service and takes no second answer.
  await expect(allow).toBeDisabled();
  await allow.click({ force: true });
  await page.waitForTimeout(300);
  expect(replies(mock)).toHaveLength(1);
});

test('calls that wait together are answered one after another', async ({ page }) => {
  const mock = await connect(page);
  await open(page, two.title);
  const dock = page.getByRole('region', { name: '需要你的许可' });
  await expect(dock.locator('.approval-dock-more')).toHaveText('另有 1 项等待');
  await expect(dock.locator('.tool-command')).toHaveText('npm run lint');
  await dock.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect.poll(() => replies(mock)).toHaveLength(1);
  const [first, second] = approvals.get(two.id)!;
  expect(replies(mock)[0]).toMatchObject({ approvalId: first, allowed: false });
  mock.push(two, { type: 'approval.resolved', approvalId: first, allowed: false });
  await expect(dock.locator('.tool-command')).toHaveText('npm test');
  await expect(dock.locator('.approval-dock-more')).toHaveCount(0);
  await dock.getByRole('button', { name: '允许', exact: true }).click();
  await expect.poll(() => replies(mock)).toHaveLength(2);
  expect(replies(mock)[1]).toMatchObject({ approvalId: second, allowed: true });
});

test('an answer the service refuses can be given again', async ({ page }) => {
  const mock = await connect(page);
  mock.refuse = true;
  await open(page, command.title);
  const allow = page
    .getByRole('region', { name: '需要你的许可' })
    .getByRole('button', { name: '允许', exact: true });
  await allow.click();
  await expect.poll(() => replies(mock)).toHaveLength(1);
  await expect(allow).toBeEnabled();
});

test('the dock carries the stop button of the box it stands in for', async ({ page }) => {
  const mock = await connect(page);
  await open(page, command.title);
  await page
    .getByRole('region', { name: '需要你的许可' })
    .getByRole('button', { name: '停止运行', exact: true })
    .click();
  await expect
    .poll(() => mock.commands.filter((item) => item.type === 'run.cancel'))
    .toHaveLength(1);
});

test("Claude's questions come one at a time, answered with the keys", async ({ page }) => {
  const mock = await connect(page);
  await open(page, question.title);
  const dock = page.getByRole('form', { name: 'Claude 的提问' });
  await expect(dock).toBeVisible();
  await expect(dock.locator('.approval-dock-pager')).toContainText('1 / 2');
  await expect(dock.locator('legend')).toContainText('登录状态放在哪里？');
  await expect(messageBox(page)).toBeHidden();
  await expect(page.locator('.transcript .tool.docked .tool-await')).toHaveText('在下方回答');
  // A choice's preview shows under the choices while it has the focus (not under the pointer, which the growing
  // dock would move it from).
  const zustand = dock.getByRole('radio', { name: 'Zustand', exact: true });
  await zustand.hover();
  await expect(dock.locator('.approval-dock-preview')).toHaveCount(0);
  await dock.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(zustand).toBeFocused();
  await expect(dock.locator('.approval-dock-preview')).toContainText('create((set) => ({}))');
  // A choice picked with the pointer turns the page; the keys go on answering on the next one.
  await zustand.click();
  await expect(dock.locator('.approval-dock-pager')).toContainText('2 / 2');
  await expect(dock.locator('legend')).toContainText('要顺手补测试吗？');
  await page.keyboard.press('1');
  await expect(dock.getByRole('checkbox', { name: '单元测试', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // ← goes back without losing what was chosen, → comes forward again.
  await page.keyboard.press('ArrowLeft');
  await expect(zustand).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(dock.locator('.approval-dock-pager')).toContainText('2 / 2');
  // The number after the choices is the answer in one's own words.
  await page.keyboard.press('3');
  await expect(dock.getByLabel('其他回答：要顺手补测试吗？')).toBeFocused();
  await page.keyboard.type('只补登录相关的');
  await page.keyboard.press('Enter');
  await expect.poll(() => replies(mock)).toHaveLength(1);
  expect(replies(mock)[0]).toMatchObject({
    approvalId: approvals.get(question.id)![0],
    allowed: true,
    answers: {
      '登录状态放在哪里？': 'Zustand',
      '要顺手补测试吗？': '单元测试, 只补登录相关的',
    },
  });
});

test('a question can be left unanswered, and one without choices is answered in words', async ({
  page,
}) => {
  const mock = await connect(page);
  await open(page, question.title);
  await page
    .getByRole('form', { name: 'Claude 的提问' })
    .getByRole('button', { name: '不回答', exact: true })
    .click();
  await expect.poll(() => replies(mock)).toHaveLength(1);
  expect(replies(mock)[0]).toMatchObject({ allowed: false });
  expect(replies(mock)[0]).not.toHaveProperty('answers');

  await open(page, words.title);
  const dock = page.getByRole('form', { name: 'Claude 的提问' });
  await expect(dock.getByRole('radio')).toHaveCount(0);
  await dock.getByLabel('其他回答：新模块叫什么名字？').fill('auth-store');
  await dock.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect.poll(() => replies(mock)).toHaveLength(2);
  expect(replies(mock)[1]).toMatchObject({
    allowed: true,
    answers: { '新模块叫什么名字？': 'auth-store' },
  });
});

test('a plan is read in the dock and sent back for more planning', async ({ page }) => {
  const mock = await connect(page);
  await open(page, plan.title);
  const dock = page.getByRole('region', { name: '计划审批' });
  await expect(dock).toBeVisible();
  await expect(dock.getByRole('heading', { name: '改造登录模块' })).toBeVisible();
  await expect(dock.locator('.approval-dock-plan li')).toHaveCount(3);
  await expect(page.locator('.transcript .tool.docked')).toContainText('等待批准计划');
  await expect(page.locator('.transcript .work > summary')).toContainText('等待批准计划');
  await expect(page.locator('.transcript .tool.docked')).toContainText('改造登录模块');
  await dock.getByRole('button', { name: '继续规划', exact: true }).click();
  await expect.poll(() => replies(mock)).toHaveLength(1);
  expect(replies(mock)[0]).toMatchObject({ allowed: false });
});

test('a plan approved goes back as allowed', async ({ page }) => {
  const mock = await connect(page);
  await open(page, plan.title);
  await page
    .getByRole('region', { name: '计划审批' })
    .getByRole('button', { name: '批准并执行', exact: true })
    .click();
  await expect.poll(() => replies(mock)).toHaveLength(1);
  expect(replies(mock)[0]).toMatchObject({ allowed: true });
});

test('the dock folds into a bar for a message first, and keeps what was chosen', async ({
  page,
}) => {
  await connect(page);
  await open(page, question.title);
  const dock = page.getByRole('form', { name: 'Claude 的提问' });
  await dock.getByRole('radio', { name: 'React Context', exact: true }).click();
  await expect(dock.locator('.approval-dock-pager')).toContainText('2 / 2');
  await dock.getByRole('button', { name: '输入消息', exact: true }).click();
  await expect(dock).toBeHidden();
  await expect(messageBox(page)).toBeVisible();
  await expect(messageBox(page)).toBeFocused();
  const bar = page.locator('.approval-dock-bar');
  await expect(bar).toContainText('Claude 在等你回答：登录状态放在哪里？');
  await page.keyboard.type('先说一句');
  await bar.getByRole('button', { name: '去回答', exact: true }).click();
  await expect(dock).toBeVisible();
  await expect(messageBox(page)).toBeHidden();
  await expect(dock.locator('.approval-dock-pager')).toContainText('2 / 2');
  await page.keyboard.press('ArrowLeft');
  await expect(dock.getByRole('radio', { name: 'React Context', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await dock.getByRole('button', { name: '输入消息', exact: true }).click();
  await expect(messageBox(page)).toHaveValue('先说一句');
});

test('a question that comes while the box is idle takes the focus, but not from someone typing', async ({
  page,
}) => {
  const mock = await connect(page);
  await open(page, later.title);
  const box = messageBox(page);
  await box.click();
  await page.waitForTimeout(1100);
  const first = asks('AskUserQuestion', choose);
  for (const payload of first.events) mock.push(later, payload);
  const dock = page.getByRole('form', { name: 'Claude 的提问' });
  await expect(dock).toBeFocused();
  await page.keyboard.press('2');
  await expect(dock.getByRole('radio', { name: 'Zustand', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  mock.push(later, { type: 'approval.resolved', approvalId: first.approvalId, allowed: false });
  await expect(dock).toHaveCount(0);
  // Answered, the dock goes and the focus goes back to the box.
  await expect(box).toBeFocused();

  // Typing when the next question comes: the keys meant for the message answer nothing.
  await page.keyboard.type('还在写');
  const second = asks('AskUserQuestion', choose, 't2');
  for (const payload of second.events) mock.push(later, payload);
  await expect(dock).toBeVisible();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await expect(dock).not.toBeFocused();
  await expect(dock.getByRole('radio', { name: 'React Context', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  expect(replies(mock)).toHaveLength(0);
});

test('an answered question keeps its answers in its line', async ({ page }) => {
  await connect(page);
  await open(page, answered.title);
  for (const selector of ['.turn-process:not([open]) > summary', '.work:not([open]) > summary'])
    while (await page.locator(selector).count()) await page.locator(selector).first().click();
  await expect(page.locator('.tool.asked .tool-heading')).toContainText(
    '已回答登录状态放在哪里？ 等 2 个问题 → 叫它 "store" 就好；C:\\dir\\',
  );
});

test('a quote put into the input box folds the dock away to show it', async ({ page }) => {
  await connect(page);
  await open(page, quoting.title);
  const dock = page.getByRole('region', { name: '需要你的许可' });
  await expect(dock).toBeVisible();
  await page.locator('.message.assistant').first().hover();
  await page.getByRole('button', { name: '引用回答', exact: true }).first().click();
  await expect(dock).toBeHidden();
  await expect(messageBox(page)).toBeVisible();
  await expect(page.locator('.composer .quote-reference-chip')).toBeVisible();
  await expect(page.locator('.approval-dock-bar')).toContainText(
    'Claude 在等你审批：允许运行这条命令？',
  );
});
