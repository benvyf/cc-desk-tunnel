import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function session(title: string, minutes: number, forkedFromSessionId?: string): Session {
  return {
    id: randomUUID(),
    title,
    autoTitle: false,
    projectPath: 'D:\\工作\\分叉',
    permissionMode: 'default',
    model: null,
    effort: null,
    createdAt: minutesAgo(minutes + 100),
    updatedAt: minutesAgo(minutes),
    activeRun: null,
    ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
  } as Session;
}

async function open(page: Page) {
  const root = session('原会话', 30);
  const child = session('派生一', 5, root.id);
  const grandchild = session('派生之派生', 1, child.id);
  const other = session('无关会话', 10);
  const second = session('派生二', 20, root.id);
  const sessions = [root, child, grandchild, other, second];
  let push: (value: unknown) => void = () => {};
  await page.routeWebSocket('ws://127.0.0.1:18896/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    push = reply;
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions,
        });
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18896/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-fork-tree-token-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  return { root, child, grandchild, other, push: (value: unknown) => push(value) };
}
const rows = (page: Page) =>
  page
    .locator('.session-row')
    .evaluateAll((nodes) =>
      nodes.map(
        (node) =>
          `${'  '.repeat(Number(node.getAttribute('data-depth') ?? 0))}${node.querySelector('strong')?.textContent}`,
      ),
    );

test('forks hang under what they were forked from, with a rail, and keyboard order follows', async ({
  page,
}) => {
  await open(page);
  await expect
    .poll(() => rows(page))
    .toEqual(['原会话', '  派生一', '    派生之派生', '  派生二', '无关会话']);
  const child = page.locator('.session-row').filter({ hasText: '派生一' }).first();
  // The first fork's line goes on past its own fork to the second: drawn through the grandchild's row.
  const grandchild = page.locator('.session-row').filter({ hasText: '派生之派生' });
  await expect(grandchild.locator('.fork-rail.through')).toHaveCount(1);
  const [through, own] = await Promise.all([
    grandchild.locator('.fork-rail.through').boundingBox(),
    child.locator('.fork-rail').boundingBox(),
  ]);
  expect(Math.abs(through!.x - own!.x)).toBeLessThan(1);
  await expect(page.locator('.session-row[data-last]').filter({ hasText: '派生二' })).toHaveCount(
    1,
  );
  await expect(child.locator('.fork-rail')).toHaveCount(1);
  await expect(child.locator('.session-select')).toContainText('派生自 原会话');
  await expect(page.locator('.session-row').first().locator('.fork-rail')).toHaveCount(0);
  await page.screenshot({ path: resolve(screenshots, 'sidebar-fork-tree.png') });
  await page.locator('.session-row .session-select').first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(child.locator('.session-select')).toBeFocused();
});

test('a fork whose source is deleted comes up to the top', async ({ page }) => {
  const { root, push } = await open(page);
  await expect
    .poll(() => rows(page))
    .toEqual(['原会话', '  派生一', '    派生之派生', '  派生二', '无关会话']);
  push({ type: 'session.deleted', sessionId: root.id });
  await expect.poll(() => rows(page)).toEqual(['派生一', '  派生之派生', '无关会话', '派生二']);
});

test('a search that finds only a fork shows it at the top', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '搜索' }).click();
  await page.getByPlaceholder('搜索设备、项目或会话').fill('派生之派生');
  await expect.poll(() => rows(page)).toEqual(['派生之派生']);
  // Finding a fork and its source as well keeps them as they hang.
  await page.getByPlaceholder('搜索设备、项目或会话').fill('派生');
  await expect.poll(() => rows(page)).toEqual(['派生一', '  派生之派生', '派生二']);
});
