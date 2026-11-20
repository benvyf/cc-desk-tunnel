import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const session = (title: string, minutes: number, projectPath: string) =>
  ({
    id: randomUUID(),
    title,
    autoTitle: false,
    projectPath,
    permissionMode: 'default',
    model: null,
    effort: null,
    createdAt: minutesAgo(minutes),
    updatedAt: minutesAgo(minutes),
    activeRun: null,
  }) as Session;

// A service with two sessions, the first of which reports a slash command; what the window sends is kept.
async function open(page: Page) {
  const alpha = session('Alpha 报告', 1, 'D:\\工作\\甲项目');
  const beta = session('整理笔记', 5, 'D:\\工作\\乙项目');
  const gamma = { ...session('旧账核对', 9, 'D:\\工作\\乙项目'), archivedAt: minutesAgo(8) };
  const sent: { type: string }[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18899/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      sent.push(message);
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [alpha, beta, gamma],
        });
      if (message.type === 'session.subscribe') {
        const target = [alpha, beta, gamma].find((item) => item.id === message.sessionId)!;
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session: target,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: 1,
          hasEarlier: false,
          events: [
            {
              sessionId: target.id,
              runId: randomUUID(),
              sequence: 1,
              createdAt: minutesAgo(1),
              payload: {
                type: 'native.capabilities',
                account: {},
                models: [],
                commands: ['review'],
                commandDetails: [{ name: 'review', description: '审查改动', argumentHint: '' }],
              },
            },
          ],
        });
      }
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18899/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-palette-token-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  return { alpha, beta, sent };
}
const palette = (page: Page) => page.getByRole('dialog', { name: '命令面板' });

test('a combobox over grouped options, moved through by keys and told by its active descendant', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press('Control+KeyK');
  const box = palette(page).getByRole('combobox');
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  const listbox = palette(page).getByRole('listbox');
  await expect(box).toHaveAttribute('aria-controls', (await listbox.getAttribute('id'))!);
  await expect(listbox.getByRole('group').first()).toHaveAccessibleName('会话');
  const first = await box.getAttribute('aria-activedescendant');
  await expect(page.locator(`[id="${first}"]`)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  const second = await box.getAttribute('aria-activedescendant');
  expect(second).not.toBe(first);
  await expect(page.locator(`[id="${second}"]`)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(box).toHaveAttribute('aria-activedescendant', first!);
  await page.screenshot({ path: resolve('.local/screenshots/command-palette.png') });
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
});

test('a session, a project and a setting are gone to; nothing new is sent but what choosing a session sends', async ({
  page,
}) => {
  const { beta, sent } = await open(page);
  await page.waitForTimeout(500);
  const before = sent.length;
  await page.keyboard.press('Control+KeyK');
  await palette(page).getByRole('combobox').fill('通知');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(palette(page).getByRole('option').first()).toContainText('设置：通知');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
  // Opening, typing, moving and a setting sent nothing.
  expect(sent.slice(before).map((message) => message.type)).toEqual([]);

  await page.keyboard.press('Control+KeyK');
  await palette(page).getByRole('combobox').fill('整理');
  await page.keyboard.press('Enter');
  await expect(page.locator('.session-row.selected')).toContainText('整理笔记');
  const viaPalette = new Set(sent.slice(before).map((message) => message.type));
  // Only what opening a session from the sidebar sends: open the other one that way and compare.
  const mark = sent.length;
  await page
    .locator('.session-row')
    .filter({ hasText: 'Alpha 报告' })
    .locator('.session-select')
    .click();
  await expect(page.locator('.session-row.selected')).toContainText('Alpha 报告');
  await page.waitForTimeout(300);
  expect(viaPalette).toEqual(new Set(sent.slice(mark).map((message) => message.type)));
  expect(
    sent
      .slice(before, mark)
      .every(
        (message) =>
          !('sessionId' in message) || (message as { sessionId: string }).sessionId === beta.id,
      ),
  ).toBe(true);

  await page.keyboard.press('Control+KeyK');
  await palette(page).getByRole('combobox').fill('甲项目');
  await expect(palette(page).getByRole('group', { name: '项目' })).toBeVisible();
});

test('a slash command is put in the box, not sent; with words there already it cannot be chosen', async ({
  page,
}) => {
  const { alpha, sent } = await open(page);
  await page
    .locator('.session-row')
    .filter({ hasText: alpha.title })
    .locator('.session-select')
    .click();
  const message = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(message).toBeVisible();
  const before = sent.length;
  await page.keyboard.press('Control+KeyK');
  await palette(page).getByRole('combobox').fill('/rev');
  await expect(palette(page).getByRole('option')).toHaveText([/^\/review/]);
  await page.keyboard.press('Enter');
  await expect(message).toHaveValue('/review ');
  await expect(message).toBeFocused();
  expect(sent.slice(before).filter((item) => item.type === 'message.send')).toEqual([]);
  await page.keyboard.press('Control+KeyK');
  await palette(page).getByRole('combobox').fill('/rev');
  const option = palette(page).getByRole('option').first();
  await expect(option).toHaveAttribute('aria-disabled', 'true');
  await expect(option).toContainText('输入框已有内容');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeVisible();
});

test('Enter while an input method composes does not choose', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Control+KeyK');
  const box = palette(page).getByRole('combobox');
  await box.focus();
  await box.dispatchEvent('compositionstart');
  await box.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  await expect(palette(page)).toBeVisible();
  await box.dispatchEvent('compositionend');
});

test('another shortcut may be given to the palette, and the old one then does nothing', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press('Control+Comma');
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  await page.getByRole('button', { name: '修改快捷键：命令面板', exact: true }).click();
  await page.keyboard.press('Control+KeyP');
  await expect(page.getByRole('button', { name: '修改快捷键：命令面板', exact: true })).toHaveText(
    'Ctrl+P',
  );
  await page.keyboard.press('Control+KeyK');
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press('Control+KeyP');
  await expect(palette(page)).toBeVisible();
});

test('narrow, the palette fits the window', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await open(page);
  await page.keyboard.press('Control+KeyK');
  const bounds = (await palette(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
});

test('a session put away is found by a query, not listed without one, and opens read only to be restored', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press('Control+KeyK');
  await expect(palette(page).getByRole('option').filter({ hasText: '旧账核对' })).toHaveCount(0);
  await palette(page).getByRole('combobox').fill('旧账');
  const option = palette(page).getByRole('option').filter({ hasText: '旧账核对' });
  await expect(option).toContainText('已归档 · 打开后可恢复');
  await page.keyboard.press('Enter');
  await expect(page.locator('.archived-bar')).toContainText('已归档');
  await expect(page.locator('.archived-bar').getByRole('button', { name: '恢复' })).toBeVisible();
});
