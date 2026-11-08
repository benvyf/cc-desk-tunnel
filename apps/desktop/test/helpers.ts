import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Screenshots are for the eye and stay on this machine.
export const screenshots = resolve('.local/screenshots');
mkdirSync(resolve(screenshots, 'redesign'), { recursive: true });
export function connection() {
  return JSON.parse(readFileSync(resolve('.local/ui-test/dev-connection.json'), 'utf8')) as {
    serverUrl: string;
    token: string;
  };
}
// Native development builds now begin at email sign-in. Seed only the isolated test profile
// through its real encrypted login store to exercise the existing local simulation login.
export async function prepareSimulationLogin(page: Page) {
  await page.waitForFunction(() => window.desktop?.dev === true);
  await expect
    .poll(
      async () =>
        (await page.getByRole('heading', { name: '登录 CC Space', exact: true }).isVisible()) ||
        (await page
          .getByRole('heading', { name: '连接到 CC Space 服务', exact: true })
          .isVisible()) ||
        (await page.locator('.connection-status').isVisible()),
    )
    .toBe(true);
  const email = page.getByRole('heading', { name: '登录 CC Space', exact: true });
  if (!(await email.isVisible())) return;
  await page.evaluate(async (config) => {
    await window.desktop!.saveLogin({
      authMethod: 'manual',
      mode: 'local',
      url: config.serverUrl,
      token: config.token,
      fingerprint: '',
      remember: true,
      autoLogin: false,
    });
  }, connection());
  await page.reload();
  await expect(page.getByLabel('服务地址', { exact: true })).toBeVisible();
}
export async function login(page: Page) {
  if (
    page.context().browser() === null ||
    (await page.evaluate(() => window.desktop?.dev === true))
  )
    await prepareSimulationLogin(page);
  const config = connection();
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址').fill(config.serverUrl);
  await page.getByLabel('服务凭据').fill(config.token);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
}
// Finished turns, runs of tool calls and each call are folded; open them all to inspect the details.
export async function expandActivity(page: Page) {
  for (const selector of ['.turn-process', '.work', '.tool'])
    while (await page.locator(`${selector}:not([open]) > summary`).count())
      await page.locator(`${selector}:not([open]) > summary`).first().click();
}
export async function sessionAction(page: Page, action: string) {
  const sidebar = page.getByRole('button', { name: '展开会话列表' });
  if (await sidebar.isVisible()) await sidebar.click();
  const row = page.locator('.session-row.selected');
  await row.hover();
  await row.getByRole('button', { name: '会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
export async function search(page: Page, text: string) {
  const box = page.getByLabel('搜索会话');
  if (!(await box.isVisible()))
    await page.getByRole('button', { name: '搜索', exact: true }).click();
  await box.fill(text);
}
export async function createSession(page: Page, prefix: string) {
  const title = `${prefix} ${Date.now()}`;
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  await page.getByLabel('本机项目目录').fill('D:\\工作\\中文项目');
  const dialog = page.getByRole('dialog');
  const add = dialog.getByRole('button', { name: '添加', exact: true });
  if (await add.isVisible()) await add.click();
  else await dialog.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '新建会话 · D:\\工作\\中文项目', exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText('新会话');
  await sessionAction(page, '重命名');
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(title);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText(title);
  return title;
}
export async function send(page: Page, text: string, scenario = 'chat') {
  await page.getByLabel('模拟场景').selectOption(scenario);
  await expect(page.getByLabel('模拟场景')).toHaveValue(scenario);
  await page.getByRole('textbox', { name: '消息' }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}
export async function settled(page: Page) {
  await expect(page.getByRole('textbox', { name: '消息' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止运行', exact: true })).not.toBeVisible();
}
// Text contrast against what is actually painted behind it: translucent fills (hover, selection, ink washes)
// are composited over the first opaque surface underneath, once colour transitions (a theme change) settle.
export async function contrast(control: Locator) {
  return control.evaluate(async (element) => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
    const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    // Hover and selection fills are translucent ink: composite them over the first opaque surface behind.
    const layers: number[][] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const [r, g, b, alpha = 1] = channels(getComputedStyle(node).backgroundColor);
      if (alpha > 0) layers.unshift([r, g, b, alpha]);
      if (alpha >= 1) break;
    }
    const backdrop = layers.reduce(
      (below, [r, g, b, alpha]) =>
        [r, g, b].map((channel, i) => channel * alpha + below[i] * (1 - alpha)),
      [255, 255, 255],
    );
    const luminance = ([r, g, b]: number[]) =>
      [r, g, b]
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const text = luminance(channels(getComputedStyle(element).color)),
      background = luminance(backdrop);
    return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
  });
}
