import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/test/fixtures/model-controls.tsx';
    (await import(path)).mount();
  });
  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  return page.getByRole('slider', { name: '推理强度', exact: true });
}

test('effort follows sub-step pointer movement and commits only once after release', async ({
  page,
}) => {
  const slider = await fixture(page);
  await expect(page.getByRole('button', { name: '模型与推理强度', exact: true })).toContainText(
    'Opus 5.5',
  );
  await expect(page.getByRole('button', { name: '模型与推理强度', exact: true })).toHaveAttribute(
    'title',
    'Opus 5.5',
  );
  await expect(page.locator('.model-current')).toHaveText('Opus 5.5');
  const box = (await slider.boundingBox())!;
  const x = (position: number) => box.x + 15 + (box.width - 30) * position;
  await page.mouse.move(x(0.5), box.y + 15);
  await page.mouse.down();
  await page.mouse.move(x(0.54), box.y + 15);
  const first = await slider.inputValue();
  await page.mouse.move(x(0.58), box.y + 15);
  const second = await slider.inputValue();
  expect(Number(second)).toBeGreaterThan(Number(first));
  await expect(page.getByLabel('已提交')).toHaveText('[]');
  await page.mouse.move(x(0.82), box.y + 15);
  await expect(slider).toHaveAttribute('aria-valuetext', '极高');
  await page.mouse.up();
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh"]');
  await expect(slider).toBeDisabled();
  await expect(slider).toHaveAttribute('aria-valuetext', '极高');
  await expect(slider).toHaveValue('3');
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute('aria-valuetext', '极高');
});

test('keyboard steps between supported levels; cancelled drags and failed saves restore the committed value', async ({
  page,
}) => {
  const slider = await fixture(page);
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh"]');
  await expect(slider).toBeEnabled();
  await expect(slider).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh","low"]');
  await expect(slider).toBeEnabled();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + 15, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + 15);
  await slider.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuetext', '低');
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh","low"]');
  await page.getByRole('button', { name: '切换失败' }).click();
  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  await slider.focus();
  await page.keyboard.press('End');
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh","low","max"]');
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute('aria-valuetext', '低');
});

test('release outside the slider commits once, and closing during a drag cancels the preview', async ({
  page,
}) => {
  const slider = await fixture(page);
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, box.y - 60);
  await page.mouse.up();
  await expect(page.getByLabel('已提交')).toHaveText('["max"]');
  await expect(slider).toBeEnabled();
  await page.mouse.move(box.x + box.width - 15, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 15);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', '最高');
  await expect(page.getByLabel('已提交')).toHaveText('["max"]');
});

test('a catalog update cancels the old drag preview and keyboard navigation follows the new levels', async ({
  page,
}) => {
  const slider = await fixture(page);
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 15, box.y + 15);
  await expect(slider).toHaveAttribute('aria-valuetext', '最高');
  await page.evaluate(async () => {
    const path = '/test/fixtures/model-controls.tsx';
    (await import(path)).changeLevels(['low', 'medium', 'high']);
  });
  await expect(slider).toHaveAttribute('max', '2');
  await page.mouse.up();
  await expect(page.getByLabel('已提交')).toHaveText('[]');
  await expect(slider).toHaveAttribute('aria-valuetext', '高');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(page.getByLabel('已提交')).toHaveText('["low"]');
  await expect(slider).toBeEnabled();
  await expect(slider).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByLabel('已提交')).toHaveText('["low","high"]');
});

test('keyboard preview can be cancelled and the slider fits both themes with reduced motion', async ({
  page,
}) => {
  const slider = await fixture(page);
  await slider.focus();
  await page.keyboard.down('ArrowRight');
  await page.keyboard.press('Escape');
  await page.keyboard.up('ArrowRight');
  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', '高');
  await expect(page.getByLabel('已提交')).toHaveText('[]');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 640 });
  for (const theme of ['light', 'dark']) {
    await page
      .locator('html')
      .evaluate((node, theme) => node.setAttribute('data-theme', theme), theme);
    const menu = page.getByRole('dialog', { name: '模型与推理强度', exact: true });
    await expect(menu).toBeInViewport({ ratio: 1 });
    await menu.screenshot({ path: `.local/screenshots/effort-slider-${theme}-320.png` });
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await slider.focus();
  await page.keyboard.press('End');
  await expect(page.getByLabel('已提交')).toHaveText('["max"]');
  await expect(slider).toBeEnabled();
  await page.emulateMedia({ forcedColors: 'none' });
  const trigger = page.getByRole('button', { name: '模型与推理强度', exact: true });
  expect(
    await trigger.locator('span').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await trigger.screenshot({ path: '.local/screenshots/full-model-name-320.png' });
  await page.locator('.model-current').click();
  await expect(page.getByRole('option').filter({ hasText: 'Opus 5.5' })).toBeVisible();
});
