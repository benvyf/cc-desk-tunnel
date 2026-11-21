import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// Chinese may break between any two characters, so in a narrow window a short label beside long text was squeezed
// to one character wide and read downwards: a table's "工作量" column, the approval dock's title, its tag.
const lines = (target: Locator) =>
  target.evaluate((element) => {
    // Text only: an icon beside the words sits at its own height.
    const tops = new Set<number>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top));
    }
    return tops.size;
  });

test('short labels keep to one line in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 820 });
  const url = 'ws://127.0.0.1:18960/ws';
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const session = {
    id: randomUUID(),
    title: '窄窗口',
    autoTitle: false,
    projectPath: 'D:\\工作\\窄窗口',
    permissionMode: 'bypassPermissions',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: { id: runId, status: 'awaiting_approval', connectionId, waiting: 'approval' },
  } as Session;
  const long =
    '现在单击一个文件就多一个固定标签，满 64 个后再打开没有任何反应。改为单击复用同一个标签，双击才固定';
  const table = [
    '| 顺序 | 内容 | 解决的问题 | 工作量 |',
    '| --- | --- | --- | --- |',
    `| 1 | **临时标签复用** | ${long} | 小到中 |`,
    `| 2 | **目录树改进** | ${long}；再加 Ctrl+P 式的按文件名快速打开 | 中 |`,
  ].join('\n');
  let sequence = 0;
  const event = (payload: unknown) => ({
    sessionId: session.id,
    runId,
    sequence: ++sequence,
    createdAt: now,
    payload,
  });
  const events = [
    event({ type: 'message.user', messageId: randomUUID(), text: '列个表', scenario: 'chat' }),
    event({ type: 'run.status', status: 'running', connectionId }),
    event({ type: 'text.delta', messageId: randomUUID(), text: table }),
    event({
      type: 'tool.requested',
      toolId: 't1',
      name: 'Bash',
      input: JSON.stringify({ command: 'rm -rf /tmp/x/*' }, null, 2),
      target: 'Linux',
    }),
    event({
      type: 'approval.requested',
      approvalId: randomUUID(),
      toolId: 't1',
      reason: 'Dangerous rm operation on statically-unresolvable target: /tmp/x/*',
      safetyCheck: true,
    }),
    event({ type: 'run.status', status: 'awaiting_approval', connectionId, waiting: 'approval' }),
  ];
  await page.routeWebSocket(url, (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (!message.requestId && message.type.startsWith('terminal.')) return;
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.10',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (message.type === 'session.subscribe') {
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: false,
          events,
        });
        return;
      }
      if (message.requestId) reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-view-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();
  // Out of the way of the conversation, as a narrow window would have it.
  const collapse = page.getByRole('button', { name: '收起会话列表', exact: true });
  if (await collapse.isVisible()) await collapse.click();

  const cells = page.locator('.message-content table');
  await expect(cells).toBeVisible();
  for (const text of ['顺序', '工作量', '小到中']) {
    const cell = cells.locator('th, td').filter({ hasText: new RegExp(`^${text}$`) });
    await expect(cell).toBeVisible();
    expect(await lines(cell), text).toBe(1);
  }
  // The long column still wraps.
  expect(await lines(cells.locator('td').filter({ hasText: '满 64 个' }).first())).toBeGreaterThan(
    1,
  );

  const dock = page.getByRole('region', { name: '需要你的许可' });
  await expect(dock.getByRole('button', { name: '允许', exact: true })).toBeVisible();
  // A narrow dock in a wide window, as in a side conversation: the narrow-screen layout does not apply there.
  await dock.evaluate(
    (element, width) => ((element as HTMLElement).style.width = `${width}px`),
    Number(process.env.DOCK_WIDTH ?? 300),
  );
  expect(await lines(dock.locator('.approval-dock-head > span').first())).toBe(1);
  expect(await lines(dock.locator('.approval-dock-fold'))).toBe(1);
  expect(await lines(dock.locator('.approval-tag'))).toBe(1);
});
