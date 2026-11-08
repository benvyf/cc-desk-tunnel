import { expect, test } from '@playwright/test';

const opens = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    (window as any).terminalTest.requests.filter((r: any) => r.type === 'terminal.open'),
  );

test('a new terminal asks for the scroll display by default when the service supports it', async ({
  page,
}) => {
  await page.goto('/test/terminal-window.fixture.html?display');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect.poll(() => opens(page)).toHaveLength(1);
  expect((await opens(page))[0].display).toBe('scroll');
});

test('the saved choice is used, and an older service is never sent the field', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ terminalDisplay: 'screen' })),
  );
  await page.goto('/test/terminal-window.fixture.html?display');
  await expect.poll(() => opens(page)).toHaveLength(1);
  expect((await opens(page))[0].display).toBe('screen');
  await page.goto('/test/terminal-window.fixture.html');
  await expect.poll(() => opens(page)).toHaveLength(1);
  expect('display' in (await opens(page))[0]).toBe(false);
});
