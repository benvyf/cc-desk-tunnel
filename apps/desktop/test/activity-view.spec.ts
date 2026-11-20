import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';

// The activity view (查看活动): the bell's place at the column's head becomes a button that turns the list into
// every session by day, under what needs the user, with the opening of each latest reply this computer has seen.
const url = 'ws://127.0.0.1:18898/ws';
const now = new Date(2026, 10, 20, 15, 0, 0);
const at = (days: number, hours = 0) =>
  new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
function session(
  title: string,
  projectPath: string,
  updatedAt: string,
  extra: Partial<Session> = {},
) {
  return {
    id: randomUUID(),
    title,
    autoTitle: false,
    projectPath,
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: updatedAt,
    updatedAt,
    activeRun: null,
    ...extra,
  } as Session;
}
const waiting = session('迁移数据库', 'D:\\work\\api', at(0, 3), {
  activeRun: {
    id: randomUUID(),
    status: 'awaiting_approval',
    connectionId: randomUUID(),
  },
} as Partial<Session>);
const speed = session('测速', 'D:\\work\\cc-desk-tunnel', at(0, 1));
const greet = session('回应问候', 'D:\\work\\lus-2.0', at(1));
const contract = session('帮我看看此代持协议', 'D:\\work\\legal', at(3));
const old = session('去年的笔记', 'D:\\work\\notes', at(400));
const filler = Array.from({ length: 70 }, (_, index) =>
  session(`批量会话 ${index + 1}`, 'D:\\work\\bulk', at(10, index / 100)),
);
const sessions = [waiting, speed, greet, contract, old, ...filler];

async function connect(page: Page) {
  await page.clock.install({ time: now });
  await page.routeWebSocket(url, (route) => {
    const send = (value: object) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'device') return;
      if (!command.requestId && command.type.startsWith('terminal.')) return;
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          terminalWorkspace: { version: 1, minRows: 1 },
          sessions,
        });
        return;
      }
      if (command.type === 'session.subscribe') {
        const runId = randomUUID();
        const messageId = randomUUID();
        const event = (sequence: number, payload: unknown) => ({
          sessionId: command.sessionId,
          runId,
          sequence,
          createdAt: now.toISOString(),
          payload,
        });
        send({
          type: 'session.snapshot',
          requestId: command.requestId,
          session: sessions.find((item) => item.id === command.sessionId),
          mode: 'replace',
          firstSequence: 1,
          lastSequence: 3,
          hasEarlier: false,
          events:
            command.sessionId === speed.id
              ? [
                  event(1, {
                    type: 'message.user',
                    messageId: randomUUID(),
                    text: '测一下速度',
                    scenario: 'chat',
                  }),
                  event(2, {
                    type: 'text.delta',
                    messageId,
                    text: '100 Mbps 做 **100 台** Ubuntu',
                  }),
                  event(3, { type: 'text.delta', messageId, text: ' 的 CC 中转，绰绰有余。' }),
                ]
              : [],
        });
        return;
      }
      if (command.requestId) send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.goto('/');
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page.getByLabel('服务凭据', { exact: true }).fill('activity-view-test-token-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
}
const recent = (page: Page) => page.getByRole('navigation', { name: '最近的会话' });

test('the activity button lists every session by day under what needs the user, and comes back where it was', async ({
  page,
}) => {
  await connect(page);
  // What waits for the user is counted on the button while the projects are listed.
  const button = page.getByRole('button', { name: '查看活动（1 项需要关注）', exact: true });
  await expect(button).toHaveAttribute('title', '查看活动  Ctrl+Alt+U');
  await expect(page.locator('.activity-toggle .notice-badge')).toHaveText('1');
  // Opening a session gives this computer the opening of its latest reply.
  await page.locator('.session-row').filter({ hasText: '测速' }).locator('.session-select').click();
  await expect(page.locator('.titlebar h1')).toHaveText('测速');

  await button.click();
  const list = recent(page);
  await expect(page.getByRole('button', { name: /^查看活动/, pressed: true })).toHaveAttribute(
    'title',
    '关闭活动视图',
  );
  await expect(page.locator('.activity-toggle .notice-badge')).toHaveCount(0);
  // The session that waits is listed once, among the priorities, with its state; the rest by day, newest first.
  const rows = list.locator('.activity-row');
  await expect(rows.nth(0)).toContainText('迁移数据库');
  await expect(rows.nth(0).locator('.activity-state')).toHaveText('等待审批');
  await expect(rows.nth(0).locator('.activity-project')).toHaveText('api');
  await expect(list.locator('.activity-row').filter({ hasText: '迁移数据库' })).toHaveCount(1);
  const speedRow = rows.filter({ hasText: '测速' });
  await expect(speedRow.locator('.activity-project')).toHaveText('cc-desk-tunnel');
  await expect(speedRow.locator('.activity-preview')).toHaveText(
    '100 Mbps 做 100 台 Ubuntu 的 CC 中转，绰绰有余。',
  );
  // Under the pointer the "…" takes the project's place, and the reply's lines do not move.
  const preview = speedRow.locator('.activity-preview');
  const before = (await preview.boundingBox())!;
  await speedRow.hover();
  await expect(speedRow.getByRole('button', { name: '会话操作', exact: true })).toBeVisible();
  expect(await preview.boundingBox()).toEqual(before);
  // One never opened here has no preview: the time it changed instead, under its day.
  await expect(rows.filter({ hasText: '回应问候' }).locator('.activity-preview')).toHaveText(
    '15:00',
  );
  // Fifty rows of the days at first, then fifty more.
  await expect(rows).toHaveCount(51);
  await list.getByRole('button', { name: '显示更多 (24)', exact: true }).click();
  await expect(rows).toHaveCount(75);
  const headings = list.locator(':scope > .list-heading, .activity-day > .list-heading');
  await expect(headings).toHaveText([
    '优先事项',
    '今天',
    '昨天',
    '星期二',
    '11月10日',
    '2025年10月16日',
  ]);

  // The keyboard moves between rows as in the project list.
  await rows.nth(1).locator('.session-select').focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(2).locator('.session-select')).toBeFocused();

  // The search filters the activity as well.
  await page.locator('.sidebar').getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByPlaceholder('搜索设备、项目或会话').fill('legal');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('帮我看看此代持协议');
  await page.getByPlaceholder('搜索设备、项目或会话').fill('没有这个');
  await expect(list).toContainText('没有匹配会话');
  await page.keyboard.press('Escape');

  // Each view comes back where it was left, and the choice is kept.
  await list.evaluate((node) => {
    node.scrollTop = 300;
  });
  await page.keyboard.press('Control+Alt+KeyU');
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
  await page.keyboard.press('Control+Alt+KeyU');
  await expect(list).toBeVisible();
  expect(await list.evaluate((node) => node.scrollTop)).toBe(300);
  expect(await page.evaluate(() => JSON.parse(localStorage['proxy-prefs']).sidebarView)).toBe(
    'activity',
  );
  // A browser keeps no copies of the conversations on disk, and so none of their previews either: they live
  // as long as the page.
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => localStorage['proxy-activity-previews'] ?? '')).toBe('');
});

test('the activity view fits a narrow column without spilling sideways', async ({ page }) => {
  await connect(page);
  await page.getByRole('button', { name: /^查看活动/ }).click();
  const divider = page.getByRole('separator', { name: '调整侧栏宽度' });
  await divider.focus();
  await page.keyboard.press('Home');
  const list = recent(page);
  await expect(list.locator('.activity-row').first()).toBeVisible();
  expect(await list.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  for (const row of await list.locator('.activity-row').all())
    expect(
      await row.evaluate((node) => {
        const project = node.querySelector('.activity-project');
        return (
          !project || project.getBoundingClientRect().right <= node.getBoundingClientRect().right
        );
      }),
    ).toBe(true);
});
