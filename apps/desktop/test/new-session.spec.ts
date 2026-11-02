import { test, expect } from '@playwright/test';
import { login, send, settled } from './helpers.ts';

// The home page is the new session not yet made (spec §5.11), and a session nothing has been said in shows the
// greeting and the input box as one group in the upper middle of the page (spec §4.2, §5.10).
test('the home page greets over an input box whose first message makes and opens a session', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const main = page.locator('main.chat-workspace');
  await expect(main).toHaveClass(/new-session/);
  await expect(page.locator('.empty-greeting')).toHaveText('You’re here!');
  // No second empty state with its own "new session" button.
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await expect(main.getByRole('button', { name: '新建会话', exact: true })).toHaveCount(0);
  const box = page.getByRole('textbox', { name: '新会话的第一条消息', exact: true });
  await expect(box).toBeFocused();
  const sendButton = page.getByRole('button', { name: '新建会话并发送', exact: true });
  await expect(sendButton).toBeDisabled();
  // The greeting and the box are one group in the upper middle of the page.
  const greeting = (await page.locator('.empty-greeting').boundingBox())!;
  const card = (await page.locator('.new-session-composer .composer').boundingBox())!;
  const page0 = (await main.boundingBox())!;
  expect(card.y - (greeting.y + greeting.height)).toBeLessThan(80);
  expect(card.y + card.height).toBeLessThan(page0.y + page0.height * 0.6);
  // The project the first session goes to (in this test build, new sessions go to the first project).
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByLabel('本机项目目录').fill('D:\\工作\\首页新会话');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const before = await page.locator('.session-row').count();
  await box.fill('从首页开始的第一个问题');
  await expect(sendButton).toBeEnabled();
  await box.press('Enter');
  await expect(page.locator('.session-row')).toHaveCount(before + 1);
  await expect(page.locator('.session-row.selected strong')).toHaveText('新会话');
  await expect(page.locator('.message.user')).toContainText('从首页开始的第一个问题');
  await expect(box).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused();
  await settled(page);
  await expect(main).not.toHaveClass(/new-session/);
});

test('a session nothing has been said in keeps its input box under the greeting until the first question', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByLabel('本机项目目录').fill('D:\\工作\\空白会话');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '新建会话 · D:\\工作\\空白会话', exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText('新会话');
  const main = page.locator('main.chat-workspace');
  await expect(main).toHaveClass(/new-session/);
  await expect(page.locator('.empty-greeting')).toBeVisible();
  const greeting = (await page.locator('.empty-greeting').boundingBox())!;
  const card = (await page.locator('.composer').boundingBox())!;
  expect(card.y - (greeting.y + greeting.height)).toBeLessThan(80);
  await send(page, '第一个问题');
  await expect(page.locator('.message.user')).toContainText('第一个问题');
  await expect(main).not.toHaveClass(/new-session/);
  await expect(page.locator('.empty-greeting')).toHaveCount(0);
  await settled(page);
  const after = (await page.locator('.composer').boundingBox())!;
  expect(after.y).toBeGreaterThan(card.y + 100);
});
