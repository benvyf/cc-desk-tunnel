import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';

test('terminal entry waits for status reading and does not start another read on opening', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const sessions: Session[] = ['当前会话', '读取中切换的会话', '其他会话'].map((title) => ({
    id: randomUUID(),
    title,
    autoTitle: false,
    projectPath: 'D:\\terminal-test',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  }));
  sessions.push({
    ...sessions[0],
    id: randomUUID(),
    title: '另一连接的终端',
    activeRun: {
      id: randomUUID(),
      status: 'running',
      connectionId: randomUUID(),
      surface: 'terminal',
    },
  });
  const commands: { type: string; sessionId?: string; requestId: string }[] = [];
  let finishStatus = (_ok = true) => {};
  let endTerminal = () => {};
  let endOtherTerminal = () => {};
  const contexts = new Map<string, object>();
  await page.routeWebSocket('ws://127.0.0.1:18891/ws', (route) => {
    const send = (value: object) => route.send(JSON.stringify(value));
    endOtherTerminal = () => {
      sessions.at(-1)!.activeRun = null;
      send({ type: 'session.updated', session: sessions.at(-1)! });
    };
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 'device') return;
      if (!command.requestId && command.type.startsWith('terminal.')) return;
      if (command.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions,
        });
      if (command.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: command.requestId,
          session: sessions.find((session) => session.id === command.sessionId),
          mode: 'replace',
          firstSequence: 0,
          lastSequence: contexts.has(command.sessionId) ? 1 : 0,
          hasEarlier: false,
          events: contexts.has(command.sessionId) ? [contexts.get(command.sessionId)] : [],
        });
      if (command.type === 'session.status') {
        finishStatus = (ok = true) =>
          send({
            type: 'response',
            requestId: command.requestId,
            ok,
            ...(!ok && { code: 'native_status_failed', message: '测试：状态读取失败' }),
          });
        return;
      }
      if (command.type === 'terminal.open') {
        const terminalId = randomUUID();
        send({ type: 'terminal.opened', sessionId: command.sessionId, terminalId });
        endTerminal = () => {
          const event = {
            sessionId: command.sessionId,
            runId: terminalId,
            sequence: 1,
            createdAt: new Date().toISOString(),
            payload: {
              type: 'native.context',
              nativeSessionId: command.sessionId,
              persisted: true,
            },
          };
          contexts.set(command.sessionId, event);
          send({ type: 'session.event', event });
          send({ type: 'terminal.closed', sessionId: command.sessionId, terminalId, exitCode: 0 });
        };
      }
      send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.goto('/');
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18891/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('terminal-status-test-token-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const row = page.locator('.session-row').filter({ hasText: '当前会话' });
  await row.click();
  // Node-wide native state reads wait for terminals owned by any connection.
  await expect(page.locator('.session-row.selected')).toContainText('当前会话');
  expect(commands.filter((c) => c.type === 'session.status')).toHaveLength(0);
  endOtherTerminal();
  await expect.poll(() => commands.filter((c) => c.type === 'session.status').length).toBe(1);
  const terminal = page.getByRole('button', { name: '终端', exact: true });
  await expect(terminal).toBeDisabled();
  await expect(terminal).toHaveAttribute('title', '正在读取会话状态，完成后可打开终端');
  await row.hover();
  await row.getByRole('button', { name: '会话操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /原生终端/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  // Switching while the first read is pending must defer, rather than lose, the next read.
  await page.locator('.session-row').filter({ hasText: '读取中切换的会话' }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText('读取中切换的会话');
  expect(commands.filter((c) => c.type === 'session.status')).toHaveLength(1);
  finishStatus();
  await expect.poll(() => commands.filter((c) => c.type === 'session.status').length).toBe(2);
  expect(commands.filter((c) => c.type === 'session.status').at(-1)?.sessionId).toBe(
    sessions[1].id,
  );
  await expect(terminal).toBeDisabled();
  finishStatus(false);
  await expect(page.locator('.error-banner')).toContainText('测试：状态读取失败');
  await expect(terminal).toBeEnabled();
  // Open a different, never-selected session directly from its menu: no automatic status read races it.
  const other = page.locator('.session-row').filter({ hasText: '其他会话' });
  await other.hover();
  await other.getByRole('button', { name: '会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '原生终端', exact: true }).click();
  await expect(page.locator('.native-terminal')).toBeVisible();
  await expect.poll(() => commands.filter((c) => c.type === 'terminal.open').length).toBe(1);
  expect(commands.filter((c) => c.type === 'session.status')).toHaveLength(2);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.locator('.native-terminal')).toBeVisible();
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await expect(page.locator('.native-terminal')).toBeVisible();
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  expect(commands.filter((c) => c.type === 'terminal.open')).toHaveLength(1);
  expect(commands.filter((c) => c.type === 'terminal.close')).toHaveLength(0);
  endTerminal();
  // Ended tabs keep their output without holding the node's status-reading lock.
  await expect.poll(() => commands.filter((c) => c.type === 'session.status').length).toBe(3);
  finishStatus();
  await expect(page.locator('.native-terminal')).toBeVisible();
  await page.getByRole('button', { name: /关闭terminal-test/ }).click();
  expect(commands.filter((c) => c.type === 'terminal.close')).toHaveLength(0);
  await other.click();
  await expect(page.locator('.composer textarea')).toBeEnabled();
  await page.locator('.composer textarea').fill('/compact');
  await expect(page.getByRole('option', { name: '压缩上下文', exact: false })).toBeEnabled();
});
