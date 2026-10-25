import { test, expect, _electron } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { login } from './helpers.ts';

async function expectBrandCentered(brand: Locator) {
  const offset = await brand.evaluate((element) => {
    const mark = element.querySelector('.brand-mark')!.getBoundingClientRect();
    const name = element.querySelector('.brand-name')!.getBoundingClientRect();
    return Math.abs(mark.top + mark.height / 2 - name.top - name.height / 2);
  });
  expect(offset, 'Logo and product name must share their vertical center').toBeLessThan(0.5);
}

test('CC SPACE login and sidebar branding adapt to themes, narrow windows and interface font size', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveTitle('CC SPACE');
  const loginBrand = page.locator('.login-content > .brand');
  await expect(loginBrand).toHaveText('CC SPACE');
  await expect(loginBrand.locator('.brand-mark')).toHaveCSS('height', '44px');
  await expectBrandCentered(loginBrand);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const path = loginBrand.locator('.brand-mark path').first();
    await expect(path).toHaveCSS(
      'fill',
      theme === 'light' ? 'rgb(182, 93, 65)' : 'rgb(250, 249, 245)',
    );
    await page.screenshot({ path: resolve(`.local/screenshots/cc-space-login-${theme}.png`) });
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(loginBrand).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await login(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('.sidebar-brand .brand-name')).toHaveText('CC SPACE');
  await expect(page.locator('.sidebar-brand .brand-mark')).toHaveCSS('height', '28px');
  await expect(page.locator('.shell')).not.toHaveClass(/side-closed/);
  await page.screenshot({
    path: resolve('.local/screenshots/cc-space-desktop-dark.png'),
    animations: 'disabled',
  });
  await page.evaluate(async () => {
    const path = '/src/prefs.ts';
    const { setPrefs } = await import(path);
    setPrefs((prefs: import('../src/prefs.ts').Prefs) => ({
      ...prefs,
      fontSizes: { ...prefs.fontSizes, interface: 20 },
      theme: 'dark',
    }));
  });
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const open = page.getByRole('button', { name: '展开会话列表', exact: true });
    if (width === 320) {
      await expect(open).toBeVisible();
      await open.click();
    }
    await expect(page.locator('.shell')).not.toHaveClass(/side-closed/);
    await page.locator('.shell').evaluate(async (shell) => {
      await Promise.all(
        shell
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await expect(page.locator('.sidebar-brand .brand-name')).toBeInViewport();
    const geometry = await page.locator('.sidebar-brand').evaluate((row) => {
      const name = row.querySelector('.brand-name')!.getBoundingClientRect();
      const buttons = [...row.querySelectorAll('button')].map((button) =>
        button.getBoundingClientRect(),
      );
      return { right: name.right, next: Math.min(...buttons.map((button) => button.left)) };
    });
    expect(geometry.right).toBeLessThanOrEqual(geometry.next);
    await page.screenshot({
      path: resolve(`.local/screenshots/cc-space-sidebar-${width}.png`),
      animations: 'disabled',
    });
  }
});

test('Electron uses CC SPACE while retaining an explicit profile and recognizing old workspace roots', async () => {
  test.skip(process.platform !== 'win32');
  const directory = mkdtempSync(resolve('.local/cc-space-brand-'));
  const profile = join(directory, 'profile');
  const documents = join(directory, 'documents');
  mkdirSync(profile, { recursive: true });
  mkdirSync(documents, { recursive: true });
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ closeToTray: false }));
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
      ),
    ) as Record<string, string>,
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    expect(await application.evaluate(({ app }) => app.getName())).toBe('CC SPACE');
    expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
    expect(await page.evaluate(() => window.desktop!.windowSettings())).toEqual({
      closeToTray: false,
    });
    expect(await page.title()).toBe('CC SPACE');
    await application.evaluate(
      ({ app }, directory) => app.setPath('documents', directory),
      documents,
    );
    const roots = await page.evaluate(() => window.desktop!.workspaceRoots());
    expect(roots[0]).toBe(join(documents, 'CC SPACE'));
    expect(roots).toContain(join(documents, 'CC Desk Tunnel'));
    const oldSession = join(documents, 'CC Desk Tunnel', '2026-10-24', '120000');
    mkdirSync(oldSession, { recursive: true });
    await page.evaluate((directory) => window.desktop!.removeWorkspace(directory), oldSession);
    expect(existsSync(oldSession)).toBe(false);
    const custom = join(directory, 'my-workspace');
    mkdirSync(custom);
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, custom);
    expect((await page.evaluate(() => window.desktop!.chooseWorkspace(false)))[0]).toBe(custom);
    const reset = await page.evaluate(() => window.desktop!.chooseWorkspace(true));
    expect(reset[0]).toBe(join(documents, 'CC SPACE'));
    expect(reset).toContain(custom);
    expect(reset).toContain(join(documents, 'CC Desk Tunnel'));
  } finally {
    await application.close();
  }
});

test('a full-length connection label leaves the brand and sidebar actions readable at maximum font size', async () => {
  test.skip(process.platform !== 'win32');
  const profile = mkdtempSync(resolve('.local/cc-space-detail-'));
  const name = '用于验证完整连接名称在窄窗口和最大字号下的显示';
  mkdirSync(join(profile, 'shared'));
  writeFileSync(
    join(profile, 'shared/connections.json'),
    JSON.stringify([
      { id: '', name },
      { id: '1234abcd', name: '第二连接' },
    ]),
  );
  writeFileSync(
    join(profile, 'shared/prefs.json'),
    JSON.stringify({ theme: 'light', fontSizes: { interface: 20, code: 13 } }),
  );
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
      ),
    ) as Record<string, string>,
  });
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(320, 560);
      window.setContentSize(320, 900);
    });
    await expect(page.locator('html')).toHaveCSS('font-size', '20px');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await expect(page.locator('.brand-connection')).toHaveText(name);
      for (const fontSize of [12, 14, 20]) {
        await page.evaluate((size) => {
          document.documentElement.style.fontSize = `${size}px`;
        }, fontSize);
        await expectBrandCentered(page.locator('.login-content > .brand'));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: resolve(`.local/screenshots/cc-space-long-login-${theme}.png`),
        animations: 'disabled',
      });
    }
    await login(page);
    await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const brand = page.locator('.sidebar-brand .brand');
      await expect(brand.locator('.brand-name')).toBeInViewport();
      for (const fontSize of [12, 14, 20]) {
        await page.evaluate((size) => {
          document.documentElement.style.fontSize = `${size}px`;
        }, fontSize);
        await expectBrandCentered(brand);
      }
      await expect(brand.locator('.brand-connection')).toHaveAttribute('title', name);
      const size = await brand.evaluate((element) => {
        const name = element.querySelector('.brand-name')!;
        const label = element.querySelector('.brand-connection')!;
        return {
          nameFits: name.scrollWidth <= name.clientWidth,
          labelFits: label.getBoundingClientRect().right <= element.getBoundingClientRect().right,
          stacked: label.getBoundingClientRect().top >= name.getBoundingClientRect().bottom,
        };
      });
      expect(size).toEqual({ nameFits: true, labelFits: true, stacked: true });
      await page.screenshot({
        path: resolve(`.local/screenshots/cc-space-long-sidebar-${theme}.png`),
        animations: 'disabled',
      });
    }
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1240, 900),
    );
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '关于与更新', exact: true })
      .click();
    await expect(page.locator('.about-brand .brand-name')).toHaveText('CC SPACE');
    await expect(page.locator('.about-brand .brand-mark')).toHaveCSS('height', '44px');
    await expectBrandCentered(page.locator('.about-brand'));
    await page.screenshot({
      path: resolve('.local/screenshots/cc-space-about-detail.png'),
      animations: 'disabled',
    });
  } finally {
    await application.close();
  }
});
