import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { PermissionSource, Session } from '@cc-desk-tunnel/protocol';

const now = new Date().toISOString();
const session = {
  id: randomUUID(),
  title: '规则会话',
  autoTitle: false,
  projectPath: 'D:\\工作\\规则',
  permissionMode: 'default',
  model: null,
  effort: null,
  createdAt: now,
  updatedAt: now,
  activeRun: null,
} as Session;
const sources = (sessionId?: string): PermissionSource[] => [
  {
    scope: 'user',
    path: '/home/cc/.claude/settings.json',
    status: 'ok',
    allow: ['Bash(npm test:*)'],
    deny: ['Bash(rm -rf:*)', '<b>不是标签</b>'],
    ask: [],
    defaultMode: 'acceptEdits',
  },
  ...(sessionId
    ? ([
        {
          scope: 'project',
          path: '/srv/cc/native/root/.claude/settings.json',
          status: 'invalid_json',
          allow: [],
          deny: [],
          ask: [],
        },
        {
          scope: 'local',
          path: '/srv/cc/native/root/.claude/settings.local.json',
          status: 'missing',
          allow: [],
          deny: [],
          ask: [],
        },
      ] as PermissionSource[])
    : []),
];

async function open(page: Page, offered = true) {
  const asked: { sessionId?: string }[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18898/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [session],
          ...(offered ? { permissionRules: { version: 1 } } : {}),
        });
      if (message.type === 'permissions.get') {
        asked.push(message);
        send({
          type: 'permissions.state',
          requestId: message.requestId,
          sources: sources(message.sessionId),
        });
        return send({ type: 'response', requestId: message.requestId, ok: true });
      }
      send({
        type: 'response',
        requestId: message.requestId,
        ok: message.type !== 'settings.get',
        ...(message.type === 'settings.get' ? { code: 'x', message: '不在本测试内' } : {}),
      });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18898/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-permission-rules-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  return asked;
}

test('rules are shown by where they come from, read only, as text', async ({ page }) => {
  const asked = await open(page);
  const user = page.getByRole('region', { name: '用户级' });
  await expect(user).toContainText('/home/cc/.claude/settings.json');
  await expect(user.locator('.permission-list.allow li')).toHaveText(['Bash(npm test:*)']);
  await expect(user.locator('.permission-list.deny li')).toHaveText([
    'Bash(rm -rf:*)',
    '<b>不是标签</b>',
  ]);
  await expect(user.locator('.permission-list.ask')).toContainText('无');
  await expect(user).toContainText('默认模式 acceptEdits');
  await expect(page.locator('.permission-rules b')).toHaveCount(0);
  await expect(page.locator('.permission-rules input, .permission-rules textarea')).toHaveCount(0);
  await expect(
    page.locator('.permission-rules').getByRole('button', { name: /保存|编辑|删除|添加/ }),
  ).toHaveCount(0);
  await expect(page.getByText('选择会话后可以看到它的项目级与本地规则。')).toBeVisible();
  expect(asked[0]).not.toHaveProperty('sessionId');

  await page.getByLabel('查看哪个会话的项目级规则').selectOption(session.id);
  const project = page.getByRole('region', { name: '项目级' });
  await expect(project).toContainText('云端服务器上本会话的工作目录，不是 Windows 上的项目文件夹');
  await expect(project).toContainText('文件不是有效的 JSON');
  await expect(page.getByRole('region', { name: '本地' })).toContainText('文件不存在');
  expect(asked.at(-1)).toMatchObject({ sessionId: session.id });
  await page.locator('.permission-rules').screenshot({
    path: resolve('.local/screenshots/permission-rules.png'),
  });
});

test('a service that does not offer them is not asked, and nothing is shown', async ({ page }) => {
  const asked = await open(page, false);
  await expect(page.getByRole('region', { name: 'Claude Code 设置' })).toBeVisible();
  await expect(page.locator('.permission-rules')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(asked).toHaveLength(0);
});
