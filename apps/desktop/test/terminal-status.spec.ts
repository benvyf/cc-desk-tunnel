import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';

test('terminal entry waits for status reading and does not start another read on opening', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const sessions: Session[] = ['当前会话', '其他会话'].map((title) => ({
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
  const commands: { type: string; sessionId?: string; requestId: string }[] = [];
  let finishStatus = () => {};
  await page.routeWebSocket('ws://127.0.0.1:18891/ws', (route) => {
    const send = (value: object) => route.send(JSON.stringify(value));
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
          lastSequence: 0,
          hasEarlier: false,
          events: [],
        });
      if (command.type === 'session.status') {
        finishStatus = () => send({ type: 'response', requestId: command.requestId, ok: true });
        return;
      }
      if (command.type === 'terminal.open')
        send({
          type: 'terminal.opened',
          sessionId: command.sessionId,
          terminalId: randomUUID(),
        });
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
  await expect.poll(() => commands.filter((c) => c.type === 'session.status').length).toBe(1);
  const terminal = page.getByRole('button', { name: '终端', exact: true });
  await expect(terminal).toBeDisabled();
  await expect(terminal).toHaveAttribute('title', '正在读取会话状态，完成后可打开终端');
  await row.hover();
  await row.getByRole('button', { name: '会话操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /原生终端/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  finishStatus();
  await expect(terminal).toBeEnabled();
  // Open a different, never-selected session directly from its menu: no automatic status read races it.
  const other = page.locator('.session-row').filter({ hasText: '其他会话' });
  await other.hover();
  await other.getByRole('button', { name: '会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '原生终端', exact: true }).click();
  await expect(page.locator('.native-terminal')).toBeVisible();
  await expect.poll(() => commands.filter((c) => c.type === 'terminal.open').length).toBe(1);
  expect(commands.filter((c) => c.type === 'session.status')).toHaveLength(1);
  await page.getByRole('button', { name: '关闭原生终端', exact: true }).click();
  // Deferred status reading resumes when the terminal has closed.
  await expect.poll(() => commands.filter((c) => c.type === 'session.status').length).toBe(2);
  finishStatus();
});
