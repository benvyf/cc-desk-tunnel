import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Clawd (Clawd.tsx): every pose stands on its line; the live one steps through the poses of its state; reduced
// motion holds one pose; the setting is on by default and turns him off.
const fixture = '/test/fixtures/clawd.html';
const record = (page: Page) =>
  page.evaluate(() => {
    const svg = document.querySelector('.clawd-live svg.clawd')!;
    const seen: string[] = [svg.getAttribute('data-pose')!];
    (window as any).clawdPoses = seen;
    new MutationObserver(() => seen.push(svg.getAttribute('data-pose')!)).observe(svg, {
      attributes: true,
      attributeFilter: ['data-pose'],
    });
  });
const seen = (page: Page) => page.evaluate(() => [...((window as any).clawdPoses as string[])]);
// Small steps, each rendered, so a 150ms blink is drawn rather than batched away.
async function advance(page: Page, ms: number) {
  for (let at = 0; at < ms; at += 50) {
    await page.clock.runFor(50);
    // A moment of real time for React to render (its scheduler is not on the faked clock).
    await page.waitForTimeout(5);
  }
}
const reset = (page: Page) => page.evaluate(() => ((window as any).clawdPoses.length = 0));

test('every pose stands on its line and is hidden from assistive technology', async ({ page }) => {
  await page.goto(fixture);
  const tiles = page.locator('[data-gallery]');
  await expect(tiles).toHaveCount(9);
  for (const tile of await tiles.all()) {
    const svg = tile.locator('svg.clawd');
    await expect(svg).toHaveAttribute('aria-hidden', 'true');
    const [box, line] = [await svg.boundingBox(), await tile.locator('> div').boundingBox()];
    expect(Math.abs(box!.y + box!.height - (line!.y + line!.height))).toBeLessThan(1.5);
    expect(await svg.locator('rect').count()).toBeGreaterThan(8);
  }
  // Typing shows the laptop on the ground; lifting and lowering carry it.
  for (const pose of ['type', 'lift', 'put'])
    expect(await page.locator(`[data-gallery="${pose}"] svg path`).count()).toBeGreaterThan(0);
  expect(await page.locator('[data-gallery="stand"] svg path').count()).toBe(0);
});

test('the live Clawd follows its state: blinks idle, takes out the laptop and types, waves', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(fixture);
  await record(page);
  await advance(page, 12_000);
  const idle = await seen(page);
  expect(idle).toContain('stand');
  expect(idle.some((pose) => pose === 'blink' || pose === 'wink')).toBe(true);
  expect(idle.some((pose) => ['lift', 'type', 'wave'].includes(pose))).toBe(false);

  await reset(page);
  await page.getByRole('button', { name: 'working', exact: true }).click();
  await advance(page, 4_000);
  const working = await seen(page);
  expect(working.slice(0, 2)).toEqual(['lift', 'put']);
  expect(working).toContain('type');
  expect(working).toContain('tap');
  await expect(page.locator('.clawd-live svg.clawd')).toHaveAttribute('data-state', 'working');

  await reset(page);
  await page.getByRole('button', { name: 'waiting', exact: true }).click();
  await advance(page, 3_000);
  const waiting = await seen(page);
  expect(new Set(waiting)).toEqual(new Set(['wave', 'stand']));
});

test('with reduced motion Clawd holds one pose for each state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(fixture);
  await record(page);
  await advance(page, 10_000);
  expect(new Set(await seen(page))).toEqual(new Set(['stand']));
  await page.getByRole('button', { name: 'working', exact: true }).click();
  await advance(page, 5_000);
  await expect(page.locator('.clawd-live svg.clawd')).toHaveAttribute('data-pose', 'type');
  expect(new Set(await seen(page))).toEqual(new Set(['stand', 'type']));
});

test('the appearance settings switch Clawd off and on, on by default', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+Comma');
  const toggle = page.getByRole('switch', { name: '输入框上的 Clawd' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => JSON.parse(localStorage['proxy-prefs']).mascot)).toBe(false);
  await toggle.click();
  expect(await page.evaluate(() => JSON.parse(localStorage['proxy-prefs']).mascot)).toBe(true);
});
