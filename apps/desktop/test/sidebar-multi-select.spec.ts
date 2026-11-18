import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function session(title: string, minutes: number, extra: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
    title,
    autoTitle: false,
    projectPath: 'D:\\工作\\多选',
    permissionMode: 'default',
    model: null,
    effort: null,
    createdAt: minutesAgo(minutes),
    updatedAt: minutesAgo(minutes),
    activeRun: null,
    ...extra,
  } as Session;
}

// A service that archives and deletes as asked, one at a time, and fails to delete those named `refuse`.
async function open(page: Page, { archive = true } = {}) {
  const sessions = [
    session('会话一', 1),
    session('会话二', 2),
    session('会话三', 3),
    session('运行中', 4, {
      activeRun: { id: randomUUID(), status: 'running', connectionId: randomUUID() },
    }),
    session('删不掉', 5),
  ];
  const sent: { type: string; sessionId?: string; archived?: boolean }[] = [];
  let inFlight = 0;
  let overlapped = false;
  await page.routeWebSocket('ws://127.0.0.1:18900/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage(async (raw) => {
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
          ...(archive ? { sessionArchive: { version: 1 } } : {}),
        });
      if (message.type === 'session.archive' || message.type === 'session.delete') {
        sent.push(message);
        inFlight++;
        if (inFlight > 1) overlapped = true;
        await new Promise((done) => setTimeout(done, 50));
        inFlight--;
        const target = sessions.find((item) => item.id === message.sessionId)!;
        if (target.title === '删不掉')
          return reply({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            code: 'native_mutation_failed',
            message: '原生会话更新失败',
          });
        if (message.type === 'session.delete') {
          sessions.splice(sessions.indexOf(target), 1);
          reply({ type: 'session.deleted', sessionId: target.id });
        } else {
          if (message.archived) target.archivedAt = new Date().toISOString();
          else delete target.archivedAt;
          reply({ type: 'session.updated', session: target });
        }
      }
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18900/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-multi-select-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator('.session-row')).toHaveCount(5);
  return { sessions, sent, overlapped: () => overlapped };
}
const row = (page: Page, title: string) =>
  page.locator('.session-row').filter({ hasText: title }).locator('.session-select');

test('Ctrl starts choosing, Shift takes a range, a running session cannot be taken, Esc stops', async ({
  page,
}) => {
  await open(page);
  await row(page, '会话一').click({ modifiers: ['Control'] });
  await expect(page.getByRole('toolbar', { name: '已选会话的操作' })).toContainText('已选 1 个');
  await expect(row(page, '会话一')).toHaveAttribute('role', 'checkbox');
  await expect(row(page, '会话一')).toHaveAttribute('aria-checked', 'true');
  await row(page, '会话三').click({ modifiers: ['Shift'] });
  await expect(page.getByRole('toolbar')).toContainText('已选 3 个');
  await expect(row(page, '运行中')).toHaveAttribute('aria-disabled', 'true');
  await row(page, '运行中').click({ force: true });
  await expect(page.getByRole('toolbar')).toContainText('已选 3 个');
  await row(page, '会话二').focus();
  await page.keyboard.press('Space');
  await expect(row(page, '会话二')).toHaveAttribute('aria-checked', 'false');
  await page.screenshot({ path: resolve('.local/screenshots/sidebar-multi-select.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: '已选会话的操作' })).toHaveCount(0);
  await expect(row(page, '会话一')).not.toHaveAttribute('role', 'checkbox');
});

test('several are deleted one at a time after saying how many; what failed is named and stays chosen', async ({
  page,
}) => {
  const { sent, overlapped } = await open(page);
  await row(page, '会话一').click({ modifiers: ['Control'] });
  await row(page, '会话二').click();
  await row(page, '删不掉').click();
  await page.getByRole('toolbar').getByRole('button', { name: '删除 3 个' }).click();
  const dialog = page.getByRole('dialog', { name: '删除会话' });
  await expect(dialog).toContainText('删除 3 个会话？');
  await dialog.getByRole('button', { name: '删除 3 个' }).click();
  await expect(dialog.getByRole('alert')).toContainText('1 个没有删除');
  await expect(dialog.getByRole('alert')).toContainText('删不掉：原生会话更新失败');
  expect(sent.filter((item) => item.type === 'session.delete')).toHaveLength(3);
  expect(overlapped()).toBe(false);
  await expect(page.locator('.session-row')).toHaveCount(3);
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('toolbar')).toContainText('已选 1 个');
  await expect(row(page, '删不掉')).toHaveAttribute('aria-checked', 'true');
});

test('put away, sessions go under 已归档, open read only, and come back', async ({ page }) => {
  await open(page);
  await row(page, '会话一').click({ modifiers: ['Control'] });
  await row(page, '会话二').click();
  await page.getByRole('toolbar').getByRole('button', { name: '归档 2 个' }).click();
  await expect(page.getByRole('toolbar', { name: '已选会话的操作' })).toHaveCount(0);
  const toggle = page.getByRole('button', { name: '已归档 (2)' });
  await expect(toggle).toBeVisible();
  await expect(page.locator('.session-row')).toHaveCount(3);
  await toggle.click();
  await expect(page.locator('.archived-group .session-row')).toHaveCount(2);
  await row(page, '会话一').click();
  await expect(page.locator('.archived-bar')).toContainText('已归档');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveCount(0);
  await page.locator('.archived-bar').getByRole('button', { name: '恢复' }).click();
  await expect(page.getByRole('button', { name: '已归档 (1)' })).toBeVisible();
  await expect(page.locator('.archived-bar')).toHaveCount(0);
});

test('a service that cannot archive offers deleting only', async ({ page }) => {
  await open(page, { archive: false });
  await row(page, '会话一').click({ modifiers: ['Control'] });
  await expect(page.getByRole('toolbar').getByRole('button', { name: /归档/ })).toHaveCount(0);
  await expect(page.getByRole('toolbar').getByRole('button', { name: '删除 1 个' })).toBeVisible();
});

test('what could not be put away is said by name, and stays chosen', async ({ page }) => {
  await open(page);
  await row(page, '会话一').click({ modifiers: ['Control'] });
  await row(page, '删不掉').click();
  await page.getByRole('toolbar').getByRole('button', { name: '归档 2 个' }).click();
  await expect(page.getByText('1 个会话没有归档：删不掉（原生会话更新失败）')).toBeVisible();
  await expect(page.getByRole('toolbar')).toContainText('已选 1 个');
  await expect(row(page, '删不掉')).toHaveAttribute('aria-checked', 'true');
});

test('a search keeps only the chosen rows it shows', async ({ page }) => {
  await open(page);
  await row(page, '会话一').click({ modifiers: ['Control'] });
  await row(page, '会话二').click();
  await page.locator('.sidebar').getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByPlaceholder('搜索设备、项目或会话').fill('会话一');
  await expect(page.getByRole('toolbar')).toContainText('已选 1 个');
});
