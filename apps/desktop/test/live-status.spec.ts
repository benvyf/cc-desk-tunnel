import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const folder = resolve(screenshots, '状态与更新');
mkdirSync(folder, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(folder, `${name}.png`) });

test('a run tells what it is doing, background tasks tell they are alive, and the quota sits by the message box', async ({
  page,
}) => {
  test.slow();
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  const connectionId = randomUUID();
  const make = (title: string, waiting?: 'background'): Session => ({
    id: randomUUID(),
    title,
    autoTitle: false,
    projectPath: 'D:\\工作\\状态',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: ago(900),
    updatedAt: ago(1),
    activeRun: { id: randomUUID(), status: 'running', connectionId, ...(waiting && { waiting }) },
  });
  const waiting = make('后台等待', 'background');
  const building = make('长时间的构建');
  const silent = make('没有动静');
  const tasks = [
    { id: 'a1', kind: 'local_agent', description: '核对全部用例' },
    { id: 'b1', kind: 'local_bash', description: '等待渲染结束' },
  ];
  const event = (session: Session, sequence: number, seconds: number, payload: unknown) => ({
    sessionId: session.id,
    runId: session.activeRun!.id,
    sequence,
    createdAt: ago(seconds),
    payload,
  });
  const user = (text: string) => ({
    type: 'message.user',
    messageId: randomUUID(),
    text,
    scenario: 'chat',
  });
  const histories = new Map([
    [
      waiting.id,
      [
        event(waiting, 1, 400, user('渲染并核对')),
        event(waiting, 2, 380, {
          type: 'text.delta',
          messageId: randomUUID(),
          text: '已在后台开始。',
        }),
        event(waiting, 3, 200, { type: 'native.tasks', tasks }),
        event(waiting, 4, 199, {
          type: 'native.metrics',
          context: null,
          usage: null,
          rateLimits: {
            available: true,
            measuredAt: ago(199),
            windows: [
              { name: 'five_hour', utilization: 7.2, resetsAt: ago(-7200) },
              { name: 'seven_day', utilization: 78, resetsAt: ago(-86400) },
              { name: 'seven_day:opus', utilization: 41, resetsAt: ago(-86400) },
              { name: 'seven_day_oauth_apps', utilization: 99, resetsAt: null },
            ],
          },
        }),
        event(waiting, 5, 198, {
          type: 'run.status',
          status: 'running',
          connectionId,
          waiting: 'background',
        }),
      ],
    ],
    [
      building.id,
      [
        event(building, 1, 140, user('完整构建一次')),
        event(building, 2, 135, {
          type: 'tool.requested',
          toolId: 't1',
          name: 'Bash',
          input: 'npm run build',
          target: 'Windows',
        }),
        event(building, 3, 5, { type: 'tool.progress', toolId: 't1', elapsedSeconds: 130 }),
      ],
    ],
    [
      silent.id,
      [
        event(silent, 1, 330, user('想一想')),
        event(silent, 2, 320, { type: 'text.delta', messageId: randomUUID(), text: '好的。' }),
      ],
    ],
  ]);
  let send: (value: unknown) => void = () => {};
  let continuedSession: string | undefined;
  await page.routeWebSocket('ws://127.0.0.1:18891/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [waiting, building, silent],
        });
      if (message.type === 'session.subscribe') {
        const events = histories.get(message.sessionId)!;
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session: [waiting, building, silent].find((item) => item.id === message.sessionId),
          mode: 'replace',
          firstSequence: 1,
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      }
      if (message.type === 'run.continue') {
        continuedSession = message.sessionId;
        send({
          type: 'session.updated',
          session: { ...silent, activeRun: { ...silent.activeRun!, id: randomUUID() } },
        });
      }
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18891/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-status-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const open = (session: Session) =>
    page
      .locator('.session-row')
      .filter({ hasText: session.title })
      .locator('.session-select')
      .click();

  // A task has been waited for since the run listed it; one that says nothing of itself shows only that.
  await open(waiting);
  const items = page.locator('.background-tasks').getByRole('listitem');
  await expect(items.nth(0)).toContainText(/已等待 3 分 \d+ 秒/);
  await expect(items.nth(1)).toContainText(/已等待 3 分 \d+ 秒$|已等待 3 分 \d+ 秒结束/);
  // What a task says of itself comes as it is said and is shown as text, whatever it holds.
  const progress = (payload: object) =>
    send({
      type: 'session.fragment',
      sessionId: waiting.id,
      runId: waiting.activeRun!.id,
      payload: { type: 'native.progress', taskId: 'a1', ...payload },
    });
  progress({ tool: 'Bash', toolUses: 14 });
  await expect(items.nth(0)).toContainText('第 14 次工具调用 · Bash');
  await shot(page, '01-后台任务-工具进度');
  progress({ tool: 'Read', toolUses: 15, summary: '[19/41] <b>WebKit</b> 用例通过' });
  await expect(items.nth(0)).toContainText('[19/41] <b>WebKit</b> 用例通过');
  await expect(items.nth(1)).not.toContainText('WebKit');
  await shot(page, '02-后台任务-任务自述');
  await page.setViewportSize({ width: 390, height: 800 });
  await shot(page, '07-后台任务-窄窗口');
  await page.setViewportSize({ width: 1280, height: 900 });
  // The dot breathes for a run that is alive, here and in the list.
  await expect(page.locator('.background-tasks .running-dot')).toHaveClass(/breathing/);
  await expect(
    page.locator('.session-row').filter({ hasText: waiting.title }).locator('.running-dot'),
  ).toHaveClass(/breathing/);

  // The quota is off until asked for; then the fullest weekly window counts, not the other applications'.
  const quota = page.getByRole('button', { name: '额度已用', exact: true });
  await expect(quota).toHaveCount(0);
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('proxy-prefs') ?? '{}');
    localStorage.setItem('proxy-prefs', JSON.stringify({ ...prefs, quota: true }));
  });
  await page.reload();
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18891/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-status-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await open(waiting);
  await expect(quota).toHaveText('5 小时 7% · 每周 78%');
  await expect(quota).toHaveClass(/warn/);
  await expect(quota).toHaveAttribute('title', /每周额度已用 78%/);
  await page.waitForTimeout(400);
  await shot(page, '03-输入框旁的额度');
  await quota.click();
  await expect(page.getByRole('heading', { name: '账号与额度' }).first()).toBeVisible();
  await shot(page, '04-额度-点开账号页');
  await page
    .getByRole('navigation', { name: '页面' })
    .getByRole('button', { name: '会话', exact: true })
    .click();

  // A tool at work is word of the run, however long it writes nothing; its own row tells its time.
  await open(building);
  const status = page.locator('.transcript > .run-indicator');
  await expect(status).toHaveText('运行中');
  await expect(page.locator('.transcript')).toContainText('正在运行命令');
  await expect(status.locator('.running-dot')).toHaveClass(/breathing/);
  await shot(page, '05-运行中-工具在执行');
  // A run from which nothing has come for minutes says so, and its dot rests.
  await open(silent);
  await expect(status).toHaveText('仍在运行 · 已 5 分钟没有新输出');
  await expect(status.locator('.running-dot')).not.toHaveClass(/breathing/);
  await shot(page, '06-运行中-长时间没有输出');
  // Word from the run brings it back.
  send({
    type: 'session.fragment',
    sessionId: silent.id,
    runId: silent.activeRun!.id,
    payload: { type: 'text.delta', messageId: randomUUID(), text: '继续。' },
  });
  await expect(status).toHaveText('运行中', { timeout: 15000 });
  const summary = page.getByLabel('当前任务状态', { exact: true });
  await expect(summary).toContainText('正在执行');
  expect(await summary.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgba(0, 0, 0, 0)',
  );
  expect(await summary.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
  send({
    type: 'session.updated',
    session: {
      ...silent,
      activeRun: { ...silent.activeRun!, status: 'awaiting_approval', waiting: 'question' },
    },
  });
  await expect(summary).toContainText('等待你回答');
  await expect(summary.locator('.running-dot')).not.toHaveClass(/breathing/);
  let sequence = 3;
  for (const outcome of ['cancelled', 'failed', 'completed'] as const) {
    send({ type: 'session.updated', session: { ...silent, activeRun: null } });
    const payload = {
      type: 'run.status',
      status: outcome,
      connectionId,
      ...(outcome === 'cancelled' ? { reason: '服务停止，运行未重放。' } : {}),
    };
    send({ type: 'session.event', event: event(silent, sequence++, 0, payload) });
    const label =
      outcome === 'cancelled' ? '本轮已停止' : outcome === 'failed' ? '本轮执行失败' : '本轮已完成';
    await expect(summary).toContainText(label);
    await expect(summary).toBeInViewport();
    if (outcome === 'cancelled') await expect(summary).toContainText('服务停止，运行未重放。');
    if (outcome !== 'completed')
      await expect(summary.getByRole('button', { name: '继续上一轮' })).toBeEnabled();
    else await expect(summary.getByRole('button')).toHaveCount(0);
    if (outcome === 'failed') {
      send({
        type: 'session.event',
        event: event(silent, sequence++, 0, {
          type: 'run.error',
          code: 'test_interrupted',
          message: '模拟执行中断，请检查网络',
        }),
      });
      await expect(summary).toHaveAttribute('role', 'alert');
      await expect(summary).toContainText('模拟执行中断，请检查网络');
      await shot(page, '07-任务失败-输入框上方状态');
      await page.setViewportSize({ width: 390, height: 720 });
      await expect(summary).toBeInViewport();
      await expect(summary.getByRole('button', { name: '继续上一轮' })).toBeInViewport();
      const longReason = '模拟执行中断：连接远程执行服务失败，请检查网络及工作空间状态。'.repeat(
        12,
      );
      send({
        type: 'session.event',
        event: event(silent, sequence++, 0, {
          type: 'run.error',
          code: 'test_long_reason',
          message: longReason,
        }),
      });
      await expect(summary.locator('.run-summary-detail')).toHaveAttribute('title', longReason);
      const bounds = await summary.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      expect(bounds!.height).toBeLessThan(100);
      await expect(summary.getByRole('button', { name: '继续上一轮' })).toBeInViewport();
      await shot(page, '08-任务失败-窄窗口');
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  }
  const nextRunId = randomUUID();
  send({
    type: 'session.updated',
    session: { ...silent, activeRun: { ...silent.activeRun!, id: nextRunId } },
  });
  await expect(summary).toContainText('正在执行');
  await expect(summary).not.toContainText('模拟执行中断');
  send({ type: 'session.updated', session: { ...silent, activeRun: null } });
  send({
    type: 'session.event',
    event: {
      ...event(silent, sequence++, 0, {
        type: 'run.status',
        status: 'failed',
        connectionId,
        reason: '新一轮任务中断',
      }),
      runId: nextRunId,
    },
  });
  await expect(summary).toContainText('新一轮任务中断');
  await expect(summary).not.toContainText('模拟执行中断');
  await summary.getByRole('button', { name: '继续上一轮' }).click();
  await expect.poll(() => continuedSession).toBe(silent.id);
  await expect(summary).toContainText('正在执行');
  await expect(summary).not.toContainText('新一轮任务中断');
  send({ type: 'session.updated', session: { ...silent, activeRun: null } });
  send({
    type: 'session.event',
    event: {
      ...event(silent, sequence++, 0, {
        type: 'run.status',
        status: 'failed',
        connectionId,
        reason: '连接断开前已确认失败',
      }),
      runId: randomUUID(),
    },
  });
  await expect(summary).toContainText('连接断开前已确认失败');
  // This manual native fixture returns to login on socket close. Exercise the disconnected
  // presentation directly so an already confirmed outcome remains visible in remote mode.
  await page.evaluate(
    async ({ session, events }) => {
      const source = '/src/RunStatus.tsx';
      const reactPath = '/node_modules/.vite/deps/react.js';
      const domPath = '/node_modules/.vite/deps/react-dom_client.js';
      const [{ RunSummary }, react, dom] = await Promise.all([
        import(source),
        import(reactPath),
        import(domPath),
      ]);
      const { createElement } = react.default ?? react;
      const { createRoot } = dom.default ?? dom;
      const container = document.createElement('div');
      container.id = 'disconnected-status-fixture';
      document.body.append(container);
      createRoot(container).render(
        createElement(RunSummary, {
          session,
          events,
          connected: false,
          clock: { now: () => Date.now(), activityAt: () => 0 },
          resume: () => {},
        }),
      );
    },
    {
      session: { ...silent, activeRun: null },
      events: [
        event(silent, sequence++, 0, {
          type: 'run.status',
          status: 'failed',
          connectionId,
          reason: '连接断开前已确认失败',
        }),
      ],
    },
  );
  const disconnected = page
    .locator('#disconnected-status-fixture')
    .getByLabel('当前任务状态', { exact: true });
  await expect(disconnected).toContainText('本轮执行失败');
  await expect(disconnected).toContainText('连接断开前已确认失败');
  await expect(disconnected).toHaveAttribute('role', 'alert');
  await expect(disconnected.getByRole('button')).toHaveCount(0);
});
