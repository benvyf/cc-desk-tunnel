import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

test('release announcements cannot expose an update action in a managed client', async ({
  page,
}) => {
  const commands: string[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
    const send = (message: unknown) => route.send(JSON.stringify(message));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      commands.push(message.type);
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.6',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
          update: { state: 'available', latest: '99.0.0' },
          client: { version: '99.0.0', size: 1, sha256: 'a'.repeat(64) },
        });
        send({ type: 'service.update', state: 'available', latest: '99.0.0' });
      } else if (message.requestId)
        send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18889/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('managed-fixture-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '关于与更新', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /升级服务端|检查更新|升级客户端|查看 99/ }),
  ).toHaveCount(0);
  await expect(page.getByText('没有可用的更新操作')).toBeVisible();
  expect(commands.some((command) => command.startsWith('service.update.'))).toBe(false);
});

test('a protocol mismatch directs the user to the administrator without upgrade buttons', async ({
  page,
}) => {
  await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
    route.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === 'auth')
        route.send(
          JSON.stringify({
            type: 'connection.error',
            code: 'version_mismatch',
            message: '版本不一致。',
            service: '0.3.5',
          }),
        );
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18889/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('managed-fixture-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByText(/联系管理员安装匹配的定制版/)).toBeVisible();
  await expect(page.getByRole('button', { name: /升级服务端|升级客户端|从 GitHub/ })).toHaveCount(
    0,
  );
});
