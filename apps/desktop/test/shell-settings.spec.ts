import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

async function open(page: Page, bash: boolean, modern = true) {
  const calls: object[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18927/ws', (route) => {
    let shell: string | undefined;
    const devices = () =>
      route.send(
        JSON.stringify({
          type: 'devices',
          devices: [
            {
              id: '11111111-2222-4333-8444-555555555555',
              name: '这台电脑',
              platform: 'win32',
              ready: true,
              shells: bash ? ['pwsh', 'bash'] : ['pwsh'],
              ...(shell ? { shell } : {}),
            },
          ],
        }),
      );
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'auth') {
        route.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.10',
            connectionId: '22222222-2222-4333-8444-555555555555',
            adapter: 'claude-code',
            sessions: [],
            ...(modern ? { deviceShells: { version: 1 } } : {}),
          }),
        );
        devices();
      }
      if (command.type === 'device.shell') {
        calls.push(command);
        shell = command.shell ?? undefined;
        devices();
        route.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
      }
    });
  });
  await page.goto('/test/fixtures/ssh-settings.html');
  await expect(page.getByRole('heading', { name: '连接', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).sshFixture.connectShell());
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: 'Shell', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Shell', exact: true })).toBeVisible();
  return calls;
}

test('Windows without Git Bash retains its Shell page and explains how to enable it', async ({
  page,
}) => {
  await open(page, false);
  await expect(page.getByLabel('首选 Shell')).toBeEnabled();
  await expect(page.getByRole('option', { name: 'Git Bash（未检测到）' })).toBeDisabled();
  await expect(page.getByText(/安装 Git for Windows 后重新连接/)).toBeVisible();
  await page.screenshot({ path: '.local/adoption-shell-unavailable.png' });
});

test('the Shell choice sends only a preference and reflects the service acknowledgement', async ({
  page,
}) => {
  const calls = await open(page, true);
  await page.getByLabel('首选 Shell').selectOption('bash');
  await expect(page.getByLabel('首选 Shell')).toHaveValue('bash');
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ type: 'device.shell', shell: 'bash' });
  expect(Object.keys(calls[0])).toEqual(['type', 'shell', 'requestId']);
  await expect(page.getByText(/已打开的终端需重新打开/)).toBeVisible();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator('.shell')).toHaveClass(/side-closed/);
  await page.screenshot({ path: '.local/adoption-shell-preference.png', animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an older service leaves Shell controls disabled without sending an unsupported command', async ({
  page,
}) => {
  const calls = await open(page, true, false);
  await expect(page.getByLabel('首选 Shell')).toBeDisabled();
  await expect(page.getByText(/此服务端尚不支持 Shell 设置/)).toBeVisible();
  expect(calls).toEqual([]);
});
