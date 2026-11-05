import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    cleanupFixture: { calls: string[] };
  }
}

async function setup(page: import('@playwright/test').Page, scenario = 'normal') {
  await page.addInitScript((scenario) => {
    const noOp = () => {};
    const calls: string[] = [];
    let failed = false;
    window.cleanupFixture = { calls };
    const api = {
      dev: true,
      platform: 'win32',
      boot: { connection: '', shared: { connections: [], busy: [] } },
      version: async () => '0.3.9',
      loadLogin: async () => null,
      workspaceRoots: async () => [],
      windowSettings: async () => ({ closeToTray: false }),
      connections: async () => [],
      loadSchedules: async (text: string) => ({ path: '', text }),
      device: async () => ({ id: 'e04aef32-195f-48c0-a45a-34ebd8b0aa94', name: 'fixture' }),
      access: undefined,
      managedServer: undefined,
      managedUpdate: undefined,
      installerCleanup: {
        inspect: async () =>
          scenario === 'missing'
            ? null
            : {
                name: 'CC-Space-Setup-0.3.9-x64.exe',
                path:
                  'C:\\Users\\fixture\\Downloads\\' +
                  '较长的下载位置\\'.repeat(12) +
                  'CC-Space-Setup-0.3.9-x64.exe',
                size: 258354956,
              },
        keep: async () => {
          calls.push('keep');
        },
        remove: async () => {
          calls.push('remove');
          if (scenario === 'locked' && !failed) {
            failed = true;
            throw Error('暂时无法移至回收站。请关闭安装器后重试，或选择保留安装包。');
          }
        },
      },
    };
    Object.defineProperty(window, 'desktop', {
      value: new Proxy(api, {
        get: (target, key) =>
          key in target
            ? target[key as keyof typeof target]
            : String(key).startsWith('on')
              ? () => noOp
              : async () => undefined,
      }),
    });
  }, scenario);
  await page.goto('/');
}

test('installation cleanup defaults to keeping the file and never deletes without confirmation', async ({
  page,
}) => {
  await setup(page);
  const notice = page.getByRole('dialog', { name: '清理安装包', exact: true });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('可从回收站恢复');
  await expect(notice.getByRole('button', { name: '保留安装包', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.cleanupFixture.calls)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => window.cleanupFixture.calls)).toEqual(['keep']);
});

for (const close of ['Escape', '关闭']) {
  test(`${close} keeps the installer`, async ({ page }) => {
    await setup(page);
    const notice = page.getByRole('dialog', { name: '清理安装包', exact: true });
    await expect(notice).toBeVisible();
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await notice.getByRole('button', { name: close, exact: true }).click();
    await expect(notice).toHaveCount(0);
    expect(await page.evaluate(() => window.cleanupFixture.calls)).toEqual(['keep']);
  });
}

test('a locked installer explains recovery and can be retried without blocking startup', async ({
  page,
}) => {
  await setup(page, 'locked');
  const notice = page.getByRole('dialog', { name: '清理安装包', exact: true });
  await notice.getByRole('button', { name: '移至回收站', exact: true }).click();
  await expect(notice.getByRole('alert')).toContainText('关闭安装器后重试');
  await notice.getByRole('button', { name: '移至回收站', exact: true }).click();
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => window.cleanupFixture.calls)).toEqual(['remove', 'remove']);
  await expect(
    page.getByRole('heading', { name: '连接到 CC Space 服务', exact: true }),
  ).toBeVisible();
});

test('ordinary startup without an installation record shows no cleanup prompt', async ({
  page,
}) => {
  await setup(page, 'missing');
  await expect(
    page.getByRole('heading', { name: '连接到 CC Space 服务', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: '清理安装包', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.cleanupFixture.calls)).toEqual([]);
});

test('cleanup retains CC Space dialog styling with long paths in light dark and narrow windows', async ({
  page,
}, testInfo) => {
  await setup(page);
  const notice = page.getByRole('dialog', { name: '清理安装包', exact: true });
  await expect(notice).toBeVisible();
  for (const [theme, width] of [
    ['light', 1280],
    ['dark', 1280],
    ['dark', 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.mouse.move(0, 0);
    await notice.evaluate(async (element) => {
      await Promise.allSettled(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await expect(notice.getByRole('button', { name: '移至回收站', exact: true })).toBeInViewport();
    await expect(notice.locator('..')).toHaveAttribute('data-kind', 'dialog');
    await page.screenshot({ path: testInfo.outputPath(`installer-cleanup-${theme}-${width}.png`) });
  }
  await notice.getByRole('button', { name: '移至回收站', exact: true }).click();
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => window.cleanupFixture.calls)).toEqual(['remove']);
});

test('large interface text keeps cleanup choices reachable in a short narrow window', async ({
  page,
}) => {
  await setup(page);
  const notice = page.getByRole('dialog', { name: '清理安装包', exact: true });
  await expect(notice).toBeVisible();
  await page.setViewportSize({ width: 320, height: 560 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const keep = notice.getByRole('button', { name: '保留安装包', exact: true });
  await keep.scrollIntoViewIfNeeded();
  await expect(keep).toBeInViewport();
  await keep.click();
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => window.cleanupFixture.calls)).toEqual(['keep']);
});
