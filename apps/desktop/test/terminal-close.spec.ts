import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test/terminal-window.fixture.html');
  await expect(page.locator('.native-terminal')).toContainText('Linux · Claude Code');
});

test('closing stops controls and an exit during the close request stays quiet', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).terminalTest.setCloseMode('pending'));
  await page.getByRole('button', { name: '关闭fixture', exact: true }).click();
  await page.getByRole('button', { name: '结束终端', exact: true }).click();
  const before = await page.evaluate(() => (window as any).terminalTest.controls.length);
  await page.locator('.xterm-helper-textarea').press('Enter');
  await page.evaluate(() =>
    (window as any).terminalTest.emit({ type: 'terminal.data', data: 'last output', bytes: 11 }),
  );
  await page.setViewportSize({ width: 1000, height: 700 });
  // Wait through the output callback, delayed ack and resize frame.
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).terminalTest.controls.length)).toBe(before);
  await page.evaluate(() => {
    (window as any).terminalTest.emit({ type: 'terminal.closed', exitCode: 0 });
    (window as any).terminalTest.finishClose(false);
  });
  await expect(page.locator('.native-terminal')).toHaveCount(0);
  await expect(page.locator('.native-terminal [role=alert]')).toHaveCount(0);
});

test('a genuine close failure keeps the terminal usable and allows retry', async ({ page }) => {
  await page.evaluate(() => (window as any).terminalTest.setCloseMode('fail'));
  await page.getByRole('button', { name: '关闭fixture', exact: true }).click();
  await page.getByRole('button', { name: '结束终端', exact: true }).click();
  await expect(page.locator('.native-terminal [role=alert]')).toContainText('测试：关闭失败');
  await page.locator('.xterm-helper-textarea').press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input')
            .length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => (window as any).terminalTest.setCloseMode('normal'));
  await page.getByRole('button', { name: '关闭fixture', exact: true }).click();
  await page.getByRole('button', { name: '结束终端', exact: true }).click();
  await expect(page.locator('.native-terminal')).toHaveCount(0);
  await expect(page.locator('.native-terminal [role=alert]')).toHaveCount(0);
});

test('natural exit shows neutral status and closing it sends no duplicate close request', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).terminalTest.setCloseMode('fail'));
  await page.getByRole('button', { name: '关闭fixture', exact: true }).click();
  await page.getByRole('button', { name: '结束终端', exact: true }).click();
  await expect(page.locator('.native-terminal [role=alert]')).toContainText('测试：关闭失败');
  await page.evaluate(() =>
    (window as any).terminalTest.emit({ type: 'terminal.closed', exitCode: 0 }),
  );
  await expect(page.locator('.native-terminal')).toContainText('已结束 · 退出码 0');
  await expect(page.locator('.native-terminal [role=alert]')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭fixture', exact: true }).click();
  await expect(page.locator('.native-terminal')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).terminalTest.requests.map((r: any) => r.type)),
  ).toEqual(['terminal.open', 'terminal.close']);
});
