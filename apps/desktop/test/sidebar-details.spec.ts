import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';
import { login } from './helpers.ts';

// The side column's details (spec §6.1, §6.3–6.8): its width and the narrow window, rows that keep their state
// under the pointer, the card for a cut-off title, folding rows, the other computers, the scheduled tasks'
// switches, the list while the native terminal has the window, the keyboard, and the account's menu.
const url = 'ws://127.0.0.1:18897/ws';
const other = { id: randomUUID(), name: '家里台式机' };
const minutes = (count: number) => new Date(Date.now() - count * 60_000).toISOString();
function session(title: string, projectPath: string, age: number, extra: Partial<Session> = {}) {
  return {
    id: randomUUID(),
    title,
    autoTitle: false,
    projectPath,
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: minutes(age + 60),
    updatedAt: minutes(age),
    activeRun: null,
    ...extra,
  } as Session;
}
const running = session('压测脚本', 'D:\\work\\api', 1, {
  activeRun: { id: randomUUID(), status: 'running', connectionId: randomUUID() },
} as Partial<Session>);
const long = session('修复时区导致的统计偏差（UTC 与本地时间混用）以及报表里的重复行', 'D:\\work\\api', 5);
const short = session('审计日志', 'D:\\work\\api', 9);
const docs = session('整理发布说明', 'D:\\work\\docs', 30);
const elsewhere = [
  session('季度复盘材料', 'E:\\notes\\review', 50, { device: other } as Partial<Session>),
  session('批量重命名照片', 'C:\\Users\\home\\CC\\2026-10-30\\101500', 70, {
    device: other,
  } as Partial<Session>),
];
const sessions = [running, long, short, docs, ...elsewhere];

async function connect(page: Page) {
  const commands: { type: string }[] = [];
  await page.routeWebSocket(url, (route) => {
    const send = (value: object) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 'device') return;
      if (!command.requestId && command.type.startsWith('terminal.')) return;
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          terminalWorkspace: { version: 1, minRows: 1 },
          sessions,
        });
        send({ type: 'devices', devices: [{ ...other, platform: 'win32', ready: true }] });
        return;
      }
      if (command.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: command.requestId,
          session: sessions.find((item) => item.id === command.sessionId),
          mode: 'replace',
          firstSequence: 0,
          lastSequence: 0,
          hasEarlier: false,
          events: [],
        });
      if (command.type === 'terminal.open')
        send({ type: 'terminal.opened', sessionId: command.sessionId, terminalId: randomUUID() });
      send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.goto('/');
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page.getByLabel('服务凭据', { exact: true }).fill('sidebar-details-test-token-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  return commands;
}
const row = (page: Page, title: string) =>
  page.locator('.session-row').filter({ hasText: title }).first();

test('the column is 288px beside the page, folds on its own below its width and 600px, and the rail gives way below 600', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const shell = page.locator('.shell');
  const sidebar = page.locator('.shell > .sidebar');
  const rail = page.getByRole('navigation', { name: '页面', exact: true });
  await expect(sidebar).toBeVisible();
  expect((await sidebar.boundingBox())!.width).toBe(288);
  expect((await sidebar.boundingBox())!.x).toBe(0);
  const divider = page.getByRole('separator', { name: '调整侧栏宽度' });
  await expect(divider).toHaveAttribute('aria-valuemin', '240');
  await expect(divider).toHaveAttribute('aria-valuemax', '420');
  // 888 = 288 + 600: the column stays beside the page; one pixel less and it folds to the rail.
  await page.setViewportSize({ width: 888, height: 800 });
  await expect(shell).not.toHaveClass(/side-overlay/);
  await expect(sidebar).toBeVisible();
  expect((await page.locator('main.workspace').boundingBox())!.width).toBe(600);
  await page.setViewportSize({ width: 887, height: 800 });
  await expect(shell).toHaveClass(/side-overlay/);
  await expect(sidebar).toBeHidden();
  await expect(rail).toBeVisible();
  expect((await rail.boundingBox())!.width).toBe(52);
  // Opened, it lies over the page from the window's edge, with a shade; the page does not move.
  const page0 = (await page.locator('main.workspace').boundingBox())!;
  await rail.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByLabel('搜索会话', { exact: true })).toBeFocused();
  await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);
  await expect(page.locator('.sidebar-shade')).toBeVisible();
  expect((await page.locator('main.workspace').boundingBox())!.x).toBe(page0.x);
  await page.keyboard.press('Escape');
  await page.locator('.sidebar-shade').click({ position: { x: 700, y: 300 } });
  await expect(sidebar).toBeHidden();
  // Below 600px the rail gives way too; the title bar's button opens the column.
  await page.setViewportSize({ width: 560, height: 800 });
  await expect(rail).toBeHidden();
  expect((await page.locator('main.workspace').boundingBox())!.x).toBe(0);
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);
  await expect(page.locator('.sidebar-account')).toBeInViewport();
  // Back on a wide window the column stands beside the page again.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(shell).not.toHaveClass(/side-overlay/);
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.sidebar-shade')).toHaveCount(0);
});

test('a row keeps its state under the pointer, offers only "…", and a cut-off title shows its card', async ({
  page,
}) => {
  await connect(page);
  const busy = row(page, '压测脚本');
  await busy.hover();
  await expect(busy.locator('small')).toHaveText('运行中');
  await expect(busy.locator('small')).toBeVisible();
  await expect(busy.getByRole('button')).toHaveText(['压测脚本运行中', '']);
  await expect(busy.getByRole('button', { name: '会话操作', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '置顶', exact: true })).toHaveCount(0);
  // A title that fits shows no card; a cut-off one does, after 700ms, beside the column.
  await row(page, '审计日志').hover();
  await page.waitForTimeout(900);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const cut = row(page, '修复时区');
  await cut.hover();
  await page.waitForTimeout(400);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const card = page.getByRole('tooltip');
  await expect(card).toContainText('以及报表里的重复行');
  const column = (await page.locator('.sidebar').boundingBox())!;
  expect((await card.boundingBox())!.x).toBe(column.x + column.width + 8);
  await page.mouse.move(900, 700);
  await expect(card).toHaveCount(0);
});

test('a project row turns its folder into the folding arrow; the other computers are a heading with a pill', async ({
  page,
}) => {
  await connect(page);
  const heading = page.locator('.project-group > h2').filter({ hasText: 'api' }).first();
  const folder = heading.locator('.fold-folder');
  const caret = heading.locator('.fold-caret');
  await page.mouse.move(900, 700);
  await expect(folder).toBeVisible();
  await expect(caret).toBeHidden();
  await heading.hover();
  await expect(folder).toBeHidden();
  await expect(caret).toBeVisible();
  await expect(heading.getByRole('button', { name: /^项目操作/ })).toBeVisible();
  await expect(heading.getByRole('button', { name: /^新建会话 · / })).toBeVisible();
  // Folded, the row counts its sessions and shows the dot of the one at work.
  await page.getByRole('button', { name: '收起项目 · api', exact: true }).click();
  const toggle = page.getByRole('button', { name: '展开项目 · api', exact: true });
  await expect(toggle.locator('small')).toHaveText('3');
  await expect(toggle).toHaveAttribute('data-state', 'running');
  await toggle.click();
  // "Other devices" is a list heading like "projects"; each computer is named with whether it is online, its
  // projects look like the ones here, and its sessions without a project are listed under it.
  const others = page.getByRole('button', { name: '展开其他设备的会话', exact: true });
  await expect(page.locator('.list-heading').filter({ has: others })).toHaveCount(1);
  await expect(others.locator('small')).toHaveText('2');
  await others.click();
  const device = page.locator('.device-heading');
  await expect(device).toContainText('家里台式机');
  await expect(device.locator('.device-state.online')).toHaveText('在线');
  await expect(page.locator('.elsewhere-project > h2')).toHaveText(['review']);
  const loose = row(page, '批量重命名照片');
  await expect(loose).toBeVisible();
  const left = async (selector: string) =>
    (await page.locator(selector).first().boundingBox())!.x;
  expect((await loose.boundingBox())!.x).toBe(await left('.device-heading'));
  expect(await left('.elsewhere-project > h2')).toBe(await left('.project-group > h2'));
  await page.getByRole('button', { name: '收起设备 · 家里台式机', exact: true }).click();
  await expect(loose).toHaveCount(0);
});

test('the list moves with ↑ ↓ and opens a row\'s menu from the keyboard', async ({ page }) => {
  await connect(page);
  const first = row(page, '压测脚本').locator('.session-select');
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, '修复时区').locator('.session-select')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('button', { name: '收起项目 · api', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: '展开其他设备的会话', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: /^项目操作 · D:\\work\\api$/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await first.focus();
  await page.keyboard.press('ContextMenu');
  const menu = page.getByRole('menu', { name: '会话操作 · 压测脚本' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '置顶', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await first.press('Enter');
  await expect(page.locator('.session-row.selected')).toContainText('压测脚本');
});

test('the account menu is as wide as the account area and opens above it', async ({ page }) => {
  await connect(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  const menu = page.getByRole('menu', { name: '设置与账号' });
  await expect(menu).toBeVisible();
  const area = (await page.locator('.sidebar-account').boundingBox())!;
  const box = (await menu.boundingBox())!;
  expect(box.x).toBe(area.x + 8);
  expect(box.width).toBe(area.width - 16);
  expect(box.y + box.height).toBeLessThanOrEqual(area.y);
  await page.keyboard.press('Escape');
  // Folded, the rail's avatar keeps the menu's own width, beside the rail.
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeHidden();
  await page
    .getByRole('navigation', { name: '页面', exact: true })
    .getByRole('button', { name: '设置与账号', exact: true })
    .click();
  expect((await menu.boundingBox())!.x).toBe(58);
});

test('while the native terminal has the window, rows stay readable and the column says why', async ({
  page,
}) => {
  await connect(page);
  const target = row(page, '审计日志');
  await target.hover();
  await target.getByRole('button', { name: '会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '原生终端', exact: true }).click();
  await expect(page.locator('.native-terminal')).toBeVisible();
  const note = page.locator('.side-terminal-note');
  await expect(note).toContainText('终端窗口使用中，关闭后可切换会话');
  await expect(note.getByRole('button', { name: '回到终端', exact: true })).toBeVisible();
  const select = row(page, '压测脚本').locator('.session-select');
  await expect(select).toHaveAttribute('aria-disabled', 'true');
  await expect(select).toHaveCSS('opacity', '1');
  // Playwright counts aria-disabled as disabled: the click is forced, and the row does not open.
  await select.click({ force: true });
  await expect(page.locator('.session-row.selected')).toContainText('审计日志');
  const create = page.locator('.side-action.new-session');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', '终端窗口打开时不能新建会话');
  await expect(create).toHaveCSS('opacity', '1');
});

test('a scheduled task is switched on and off by a small switch, its actions float on hover', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'proxy-schedules',
      JSON.stringify({
        tasks: [
          {
            id: 'daily-digest',
            name: '每日站会摘要',
            enabled: true,
            prompt: '汇总昨天的提交',
            schedule: { type: 'daily', time: '09:00' },
            target: { type: 'new', projectPath: 'D:\\work\\api' },
            model: null,
            effort: null,
          },
        ],
      }),
    ),
  );
  await connect(page);
  await page.locator('.side-nav').getByRole('button', { name: '定时任务', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '启用 每日站会摘要', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const box = (await toggle.boundingBox())!;
  expect([box.width, box.height]).toEqual([28, 16]);
  const task = page.locator('.schedule-row').first();
  const before = (await task.boundingBox())!.height;
  await task.hover();
  await expect(task.getByRole('button', { name: '编辑 每日站会摘要', exact: true })).toBeVisible();
  expect((await task.boundingBox())!.height).toBe(before);
  expect(before).toBeLessThan(80);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(task).toContainText('已停用');
});
