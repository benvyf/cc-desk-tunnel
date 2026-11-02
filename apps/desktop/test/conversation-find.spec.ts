import { test, expect } from '@playwright/test';
import { createSession, login, send, settled } from './helpers.ts';

// Phase 3n: the find box floats at the top right of the conversation column instead of a bar across the page, and
// the way back to the end appears only when the end is out of sight, just above the input box.
test('find floats over the column, and “回到底部” shows only away from the end, above the input box', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '查找浮框');
  await send(page, '浮动查找唯一词');
  await settled(page);
  const frame = page.locator('.workspace .conversation-frame');
  const before = (await frame.boundingBox())!;
  await page.keyboard.press('Control+f');
  const find = page.getByRole('search', { name: '对话内查找' });
  await expect(find).toBeVisible();
  const [box, column, after] = await Promise.all([
    find.boundingBox(),
    page.locator('.workspace .transcript').boundingBox(),
    frame.boundingBox(),
  ]);
  // Small, in line with the column's right edge, over the conversation rather than above it.
  expect(box!.width).toBeLessThanOrEqual(360);
  expect(Math.abs(box!.x + box!.width - (column!.x + column!.width))).toBeLessThanOrEqual(2);
  expect(after!.y).toBe(before.y);
  await expect(find).toHaveCSS('position', 'absolute');
  // Opening the find box leaves the end, but a short conversation has no end out of sight.
  const back = page.getByRole('button', { name: '回到底部', exact: true });
  await expect(back).toHaveCount(0);
  await find.getByRole('textbox').press('Escape');

  await send(page, Array.from({ length: 90 }, (_, index) => `第 ${index + 1} 行`).join('\n'));
  await settled(page);
  const conversation = page.locator('.workspace .conversation');
  await conversation.hover();
  await page.mouse.wheel(0, -1500);
  await expect(back).toBeVisible();
  const [button, composer] = await Promise.all([
    back.boundingBox(),
    page.locator('.workspace .composer').boundingBox(),
  ]);
  // Over the foot of the conversation, right above the input box, in the middle of the column.
  expect(button!.y + button!.height).toBeLessThanOrEqual(composer!.y);
  expect(composer!.y - (button!.y + button!.height)).toBeLessThan(60);
  const middle = (await page.locator('.workspace .transcript').boundingBox())!;
  expect(Math.abs(button!.x + button!.width / 2 - (middle.x + middle.width / 2))).toBeLessThan(12);
  await back.click();
  await expect(back).toHaveCount(0);
});
