import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { login } from './helpers.ts';

// The call log's two filters (spec §5.3: a segmented control holds at most five choices) and the scheduled task
// editor's 24-hour time and weekday pills (spec §5.3, §6.7).
const url = 'ws://127.0.0.1:18899/ws';
const zero = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};
async function usage(page: Page) {
  const queries: { from: string; to: string }[] = [];
  await page.routeWebSocket(url, (route) => {
    const send = (value: object) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'device') return;
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
        });
        send({
          type: 'account.state',
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'test@example.com',
          subscriptionType: 'Max',
          login: null,
        });
        return;
      }
      // A reply with data is followed by the request's response, as the service does.
      if (command.type === 'usage.summary')
        send({
          type: 'usage.summary',
          requestId: command.requestId,
          retentionDays: 30,
          firstRecordAt: null,
          windows: [
            {
              name: 'five_hour',
              startedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
              resetsAt: null,
              utilization: 30,
              ...zero,
            },
            {
              name: 'seven_day',
              startedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
              resetsAt: null,
              utilization: 58,
              ...zero,
            },
          ],
        });
      if (command.type === 'usage.query') {
        queries.push(command);
        send({
          type: 'usage.page',
          requestId: command.requestId,
          rows: [],
          hasMore: false,
          totals: { ...zero, durationMs: 0, ttftMs: null, outputPerSecond: null },
          models: [],
          byModel: [],
          series: [],
        });
      }
      if (command.requestId) send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.goto('/');
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page.getByLabel('服务凭据', { exact: true }).fill('page-controls-test-token-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: /^账号/ }).click();
  await page.getByRole('button', { name: '调用日志', exact: true }).click();
  return queries;
}

test('the call log offers five ranges in one control and the quota periods in a list beside it', async ({
  page,
}) => {
  const queries = await usage(page);
  const ranges = page.getByRole('group', { name: '时间范围', exact: true });
  await expect(ranges.getByRole('button')).toHaveText([
    '今日',
    '24 小时',
    '7 天',
    '30 天',
    '自定义',
  ]);
  // Every choice shows whole: none is cut off at the control's edge.
  for (const button of await ranges.getByRole('button').all())
    expect(await button.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const quota = page.getByRole('combobox', { name: '额度周期', exact: true });
  await expect(quota).toHaveValue('');
  await expect(quota.locator('option:not([disabled])')).toHaveText([
    '本期5 小时额度',
    '本期每周额度',
  ]);
  await quota.selectOption({ label: '本期每周额度' });
  await expect(quota).toHaveValue('seven_day');
  await expect(ranges.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect
    .poll(() => Date.now() - Date.parse(queries.at(-1)!.from))
    .toBeGreaterThan(2.9 * 86400_000);
  await ranges.getByRole('button', { name: '7 天', exact: true }).click();
  await expect(ranges.getByRole('button', { name: '7 天', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(quota).toHaveValue('');
});

test('a task is set to the hour and minute in 24-hour time, on days chosen as pills', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await page.locator('.side-nav').getByRole('button', { name: '定时任务', exact: true }).click();
  // With no task open the page says what it is for in a sentence; the notes wait under the form.
  const intro = page.locator('.page-body .empty-state');
  await expect(intro.getByRole('heading', { name: '安排任务', exact: true })).toBeVisible();
  await expect(intro.locator('svg')).toHaveCount(0);
  await expect(page.locator('.schedule-notes')).toHaveCount(0);
  await intro.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.locator('.schedule-notes')).toContainText('只在客户端运行并已连接时触发');
  await page.getByLabel('任务名称').fill('晚间汇总');
  await page.getByLabel('提示词').fill('总结今天的改动');
  await page.getByLabel('发送到').selectOption('new');
  await page.getByLabel('项目目录').fill('D:\\工作\\定时');
  await page.getByLabel('重复规则').selectOption('weekly');
  const days = page.getByRole('group', { name: '星期', exact: true });
  await expect(days.getByRole('button')).toHaveText([
    '周一',
    '周二',
    '周三',
    '周四',
    '周五',
    '周六',
    '周日',
  ]);
  for (const day of ['周一', '周五']) {
    const pill = days.getByRole('button', { name: day, exact: true });
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(days.getByRole('button', { name: '周六', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await days.getByRole('button', { name: '周六', exact: true }).click();
  await days.getByRole('button', { name: '周一', exact: true }).click();
  await expect(days.getByRole('button', { name: '周一', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const time = page.getByRole('group', { name: '运行时间', exact: true });
  await expect(
    time.getByRole('combobox', { name: '时', exact: true }).locator('option'),
  ).toHaveCount(24);
  await time.getByRole('combobox', { name: '时', exact: true }).selectOption('18');
  await time.getByRole('combobox', { name: '分', exact: true }).selectOption('30');
  // No AM / PM anywhere in the editor.
  await expect(page.locator('.schedule-form')).not.toContainText(/AM|PM|上午|下午/);
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  const saved = () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('proxy-schedules') ?? '{"tasks":[]}').tasks.find(
          (task: { name: string }) => task.name === '晚间汇总',
        )?.schedule,
    );
  await expect.poll(saved).toEqual({ type: 'weekly', days: [2, 3, 4, 5, 6], time: '18:30' });
  // Once: a date and the same hours and minutes.
  const row = page.locator('.schedule-row').filter({ hasText: '晚间汇总' });
  await row.hover();
  await row.getByRole('button', { name: '编辑 晚间汇总', exact: true }).click();
  await expect(time.getByRole('combobox', { name: '时', exact: true })).toHaveValue('18');
  await page.getByLabel('重复规则').selectOption('once');
  await page.getByLabel('运行日期', { exact: true }).fill('2030-05-06');
  await time.getByRole('combobox', { name: '时', exact: true }).selectOption('07');
  await time.getByRole('combobox', { name: '分', exact: true }).selectOption('05');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect.poll(saved).toEqual({ type: 'once', at: '2030-05-06T07:05' });
});
