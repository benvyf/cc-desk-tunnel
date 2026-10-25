import { test, expect, _electron } from '@playwright/test';
import { login, createSession } from './helpers.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createProxyServer } from '../../server/src/server.ts';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
import { offlineFramebuffer } from './fixtures/offline-rfb.ts';

test('Chat/Coding occupies the old logo area and preserves the Coding draft without site requests', async ({
  page,
}) => {
  const sites: string[] = [];
  await page.route(/https?:\/\/.*(?:claude\.ai|claude\.com|anthropic\.com)/, (route) => {
    sites.push(route.request().url());
    return route.abort();
  });
  await page.goto('/');
  await login(page);
  await createSession(page, '保留编程草稿');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('尚未发送的中文草稿');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('请在桌面客户端连接远端网页')).toBeVisible();
  await page.screenshot({ path: '.local/screenshots/claude-web-chat.png' });
  await page.getByRole('tab', { name: 'Coding', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '尚未发送的中文草稿',
  );
  expect(sites).toEqual([]);
  await page.screenshot({ path: '.local/screenshots/claude-web-coding.png' });
});

test('Electron renders remote pixels and forwards input through authenticated TLS, without local website access', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance');
  test.slow();
  const directory = mkdtempSync(resolve('.local/ui-test/browser-'));
  const rfb = await offlineFramebuffer();
  const token = 'offline-personal-browser-service-token';
  const service = createProxyServer({
    token,
    dataDir: join(directory, 'server'),
    browserEndpoint: rfb.endpoint,
    tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
  });
  const address = await service.listen(0);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && name !== 'ELECTRON_RUN_AS_NODE',
    ),
  ) as Record<string, string>;
  const application = await _electron.launch({
    args: [
      resolve('apps/desktop'),
      '--smoke-test',
      `--user-data-dir=${join(directory, 'profile')}`,
    ],
    env,
  });
  try {
    const page = await application.firstWindow();
    const targets: string[] = [];
    const record = (value: string) => {
      if (/^https?:|^wss?:/.test(value)) targets.push(value);
    };
    page.on('request', (request) => record(request.url()));
    page.on('websocket', (socket) => record(socket.url()));
    await page.getByLabel('服务地址').fill(address.replace('https:', 'wss:') + '/ws');
    await page.getByLabel('服务凭据').fill(token);
    await page.getByText('高级连接选项', { exact: true }).click();
    await page
      .getByLabel('服务证书指纹', { exact: true })
      .fill(new X509Certificate(defaultCertificate.cert).fingerprint256);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: '连接远端网页', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已连接远端网页');
    const canvas = page.locator('.claude-web-screen canvas');
    await expect
      .poll(() =>
        canvas.evaluate((element) =>
          Array.from(
            (element as HTMLCanvasElement).getContext('2d')!.getImageData(1, 1, 1, 1).data,
          ),
        ),
      )
      .toEqual([0x33, 0x77, 0xaa, 255]);
    await canvas.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('a');
    await expect.poll(() => rfb.keys.some((key) => key.down && key.symbol === 97)).toBe(true);
    await expect.poll(() => rfb.pointers.some((buttons) => buttons === 1)).toBe(true);
    await page.keyboard.down('Shift');
    await expect.poll(() => rfb.keys.some((key) => key.down && key.symbol === 65505)).toBe(true);
    await page.getByRole('tab', { name: 'Coding', exact: true }).click();
    await page.keyboard.up('Shift');
    await expect.poll(() => rfb.keys.some((key) => !key.down && key.symbol === 65505)).toBe(true);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已连接远端网页');
    expect(rfb.connections()).toBe(1);
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(100);
    const refusals = await page.evaluate(async () =>
      Promise.all([
        window.desktop!.openExternal('https://claude.ai/').then(
          () => '',
          (error: Error) => error.message,
        ),
        window.desktop!.openWeb('https://claude.ai/').then(
          () => '',
          (error: Error) => error.message,
        ),
      ]),
    );
    expect(refusals.every((reason) => reason.includes('远端浏览器'))).toBe(true);
    await page.screenshot({ path: '.local/screenshots/claude-web-electron-offline.png' });
    await page.getByRole('button', { name: '登录需要处理', exact: true }).click();
    await expect(
      page.getByText('已暂停网页操作，请联系管理员处理登录，再手动重新连接。'),
    ).toBeVisible();
    await page.getByRole('button', { name: '连接远端网页', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已连接远端网页');
    rfb.disconnect();
    await expect(page.getByRole('status')).toHaveText('远端网页连接中断，请重新连接');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((value) => new URL(value).hostname === '127.0.0.1')).toBe(true);
  } finally {
    await application.close();
    await service.close();
    await rfb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
