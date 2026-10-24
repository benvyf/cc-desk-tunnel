import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

test('saved defaults survive reload, initialize new sessions before sending, and leave existing sessions alone', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const original: Session = {
    id: randomUUID(),
    title: '已有会话',
    autoTitle: false,
    projectPath: 'D:\\工作\\默认模型',
    permissionMode: 'default',
    model: 'sonnet',
    effort: 'medium',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const sessions = [original];
  const configured: Record<string, unknown>[] = [];
  let hold = true;
  let fail = false;
  let release: (() => void) | undefined;
  const models = [
    {
      value: 'default',
      displayName: '默认模型',
      description: '',
      source: 'native',
      supportedEffortLevels: ['low', 'medium', 'high'],
    },
    {
      value: 'opus',
      displayName: 'Opus',
      resolvedModel: 'claude-opus-5-5',
      description: '',
      source: 'native',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'sonnet',
      displayName: 'Sonnet',
      description: '',
      source: 'native',
      supportedEffortLevels: ['low', 'medium', 'high'],
    },
  ];
  await page.routeWebSocket('ws://127.0.0.1:18890/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      const response = (sessionId?: string) =>
        send({ type: 'response', requestId: message.requestId, ok: true, sessionId });
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.6',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions,
        });
        return;
      }
      if (message.type === 'session.subscribe') {
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session: sessions.find((item) => item.id === message.sessionId),
          mode: 'replace',
          firstSequence: 1,
          lastSequence: 1,
          hasEarlier: false,
          events: [
            {
              sessionId: message.sessionId,
              runId: randomUUID(),
              sequence: 1,
              createdAt: now,
              payload: { type: 'native.capabilities', account: {}, commands: [], models },
            },
          ],
        });
      }
      if (message.type === 'session.create') {
        const session = {
          ...original,
          id: randomUUID(),
          title: message.title,
          projectPath: message.projectPath,
          model: null,
          effort: null,
        };
        sessions.push(session);
        send({ type: 'session.updated', session });
        response(session.id);
        return;
      }
      if (message.type === 'session.configure') {
        configured.push(message);
        if (fail) {
          send({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            message: '测试配置失败',
          });
          return;
        }
        const session = sessions.find((item) => item.id === message.sessionId)!;
        const finish = () => {
          Object.assign(session, { model: message.model, effort: message.effort });
          send({ type: 'session.updated', session });
          response(session.id);
        };
        if (hold) release = finish;
        else finish();
        return;
      }
      response(message.sessionId);
    });
  });
  async function connect() {
    await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18890/ws');
    await page.getByLabel('服务凭据', { exact: true }).fill('test-only-default-model-token-long');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('.session-select').filter({ hasText: '已有会话' }).click();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  }
  async function settings() {
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '常规', exact: true })
      .click();
  }
  await page.goto('/');
  await connect();
  await settings();
  await expect(
    page.getByRole('combobox', { name: '默认模型', exact: true }).locator('option[value="opus"]'),
  ).toHaveText('Opus 5.5');
  await page.getByRole('combobox', { name: '默认模型', exact: true }).selectOption('opus');
  await page.getByRole('combobox', { name: '默认推理强度', exact: true }).selectOption('max');
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage['proxy-prefs']).sessionDefaults))
    .toEqual({ model: 'opus', effort: 'max' });
  expect(configured).toHaveLength(0);
  await page.reload();
  await connect();
  await settings();
  await expect(page.getByRole('combobox', { name: '默认模型', exact: true })).toHaveValue('opus');
  await expect(page.getByRole('combobox', { name: '默认推理强度', exact: true })).toHaveValue(
    'max',
  );
  await page.getByRole('banner').getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
  for (const theme of ['浅色', '深色']) {
    await page.getByRole('radio', { name: theme, exact: true }).click();
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 320) {
        const collapse = page
          .getByRole('banner')
          .getByRole('button', { name: '收起侧栏', exact: true });
        if (await collapse.isVisible()) await collapse.click();
        await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
      }
      const card = page.locator('.session-defaults');
      await card.scrollIntoViewIfNeeded();
      expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await card.screenshot({ path: `.local/screenshots/model-defaults-${theme}-${width}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(page.getByRole('button', { name: '模型与推理强度', exact: true })).toContainText(
    'Sonnet',
  );
  await page
    .getByRole('button', { name: `新建会话 · ${original.projectPath}`, exact: true })
    .click();
  await expect.poll(() => configured.length).toBe(1);
  expect(configured[0]).toMatchObject({ model: 'opus', effort: 'max', sessionId: sessions[1].id });
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
  release!();
  hold = false;
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '模型与推理强度', exact: true })).toContainText(
    'Opus',
  );
  expect(original.model).toBe('sonnet');
  expect(original.effort).toBe('medium');
  await settings();
  await page.getByRole('combobox', { name: '默认模型', exact: true }).selectOption('sonnet');
  await expect(page.getByRole('combobox', { name: '默认推理强度', exact: true })).toHaveValue('');
  await page.getByRole('combobox', { name: '默认推理强度', exact: true }).selectOption('high');
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await page
    .getByRole('button', { name: `新建会话 · ${original.projectPath}`, exact: true })
    .click();
  await expect.poll(() => configured.length).toBe(2);
  expect(configured[1]).toMatchObject({
    model: 'sonnet',
    effort: 'high',
    sessionId: sessions[2].id,
  });
  expect(sessions[1].model).toBe('opus');
  expect(sessions[1].effort).toBe('max');
  fail = true;
  await page.locator('.sidebar').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect.poll(() => configured.length).toBe(3);
  await expect(page.getByRole('alert')).toContainText('新会话已创建，但默认模型与推理强度未能应用');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  expect(sessions).toHaveLength(4);
  expect(configured[2].sessionId).toBe(sessions[3].id);
  fail = false;
  for (const model of ['missing-model', 'sonnet']) {
    await page.evaluate(async (model) => {
      const path = '/src/prefs.ts';
      const { setPrefs } = await import(path);
      setPrefs((prefs: Record<string, unknown>) => ({
        ...prefs,
        sessionDefaults: { model, effort: 'max' },
      }));
    }, model);
    await page.locator('.sidebar').getByRole('button', { name: '新建会话', exact: true }).click();
    await expect.poll(() => sessions.length).toBe(model === 'sonnet' ? 6 : 5);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  }
  expect(configured).toHaveLength(4);
  expect(configured[3]).toMatchObject({ model: 'sonnet', effort: null });
});
