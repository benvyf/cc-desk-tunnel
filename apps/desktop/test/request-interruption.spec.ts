import { test, expect } from '@playwright/test';
import { login, createSession, send } from './helpers.ts';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// A question the service says never reached the CLI is edited where it stands and sent again in its own session;
// one that may have arrived is sent from a copy, as every edit is (upstream 72764597, as in-place editing).
for (const delivery of ['not_sent', 'unconfirmed'] as const) {
  test(`editing a ${delivery} question follows its delivery`, async ({ page }) => {
    const url = 'ws://127.0.0.1:18914/ws';
    const now = new Date().toISOString();
    const connectionId = randomUUID(),
      runId = randomUUID(),
      messageId = randomUUID();
    const session: Session = {
      id: randomUUID(),
      title: '未送达消息',
      autoTitle: false,
      projectPath: 'D:\\work\\message-edit',
      permissionMode: 'auto',
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    const requests: { type: string; sessionId?: string; text?: string }[] = [];
    const events = [
      { type: 'message.user', messageId, text: '请先检查代码', scenario: 'chat' },
      { type: 'message.delivery', messageId, status: delivery },
      { type: 'run.status', status: 'cancelled', connectionId },
    ].map((payload, index) => ({
      sessionId: session.id,
      runId,
      sequence: index + 1,
      createdAt: now,
      payload,
    }));
    await page.routeWebSocket(url, (route) => {
      const reply = (message: unknown) => route.send(JSON.stringify(message));
      route.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'device') return;
        if (!message.requestId && message.type.startsWith('terminal.')) return;
        if (message.type === 'auth') {
          reply({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.10',
            connectionId,
            adapter: 'claude-code',
            sessions: [session],
          });
          return;
        }
        if (message.type === 'session.subscribe') {
          reply({
            type: 'session.snapshot',
            requestId: message.requestId,
            session,
            mode: 'replace',
            firstSequence: 1,
            lastSequence: events.length,
            hasEarlier: false,
            events,
          });
          return;
        }
        if (['session.fork', 'message.send'].includes(message.type)) requests.push(message);
        if (message.requestId) reply({ type: 'response', requestId: message.requestId, ok: true });
      });
    });
    await page.goto('/');
    const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
    if (await localMode.isVisible()) await localMode.click();
    await page.getByLabel('服务地址', { exact: true }).fill(url);
    await page.getByLabel('服务凭据', { exact: true }).fill('test-only-message-edit-token-long');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('.session-select').filter({ hasText: session.title }).click();
    await expect(page.locator('.message-delivery')).toHaveText(
      delivery === 'not_sent' ? '未送达原生' : '接收未确认',
    );
    await page.locator('.message.user .message-content').hover();
    const edit = page.getByRole('button', { name: '编辑消息', exact: true });
    if (delivery === 'not_sent') await expect(edit).toHaveAttribute('title', /未送达.*本会话/);
    else await expect(edit).toHaveAttribute('title', '编辑消息');
    await edit.click();
    await page.getByRole('textbox', { name: '编辑内容', exact: true }).fill('请先检查类型错误');
    await page
      .locator('.message-editor')
      .getByRole('button', { name: '发送', exact: true })
      .click();
    await expect.poll(() => requests.length).toBe(1);
    if (delivery === 'not_sent') {
      expect(requests[0]).toMatchObject({
        type: 'message.send',
        sessionId: session.id,
        text: '请先检查类型错误',
      });
      await expect(page.locator('.message-editor')).toHaveCount(0);
    } else expect(requests[0]).toMatchObject({ type: 'session.fork', sessionId: session.id });
  });
}

test('a lost acknowledgement is described as a past interruption after reconnect, without resending', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    const sent: string[] = [];
    Object.assign(window, { interruptedSends: sent });
    let interrupted = false;
    window.WebSocket = class extends Original {
      pendingMessage?: string;
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data));
          if (
            !interrupted &&
            message.type === 'response' &&
            message.requestId === this.pendingMessage
          ) {
            // The server accepted the message, but the acknowledgement did not reach the renderer.
            interrupted = true;
            event.stopImmediatePropagation();
            this.close();
          }
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
          const command = JSON.parse(data);
          if (command.type === 'message.send') {
            sent.push(command.requestId);
            this.pendingMessage = command.requestId;
          }
        }
        super.send(data);
      }
    };
  });
  await page.goto('/');
  await login(page);
  await createSession(page, '确认丢失');
  await send(page, '这条消息只能发送一次');
  await expect(page.getByText('连接中断，等待恢复', { exact: true })).toBeVisible();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await expect(page.locator('.error-banner')).toContainText('连接已恢复');
  await expect(page.locator('.error-banner')).toContainText('上次请求');
  await expect(page.locator('.error-banner')).toContainText('任务可能仍在运行');
  await expect(page.locator('.error-banner')).toContainText('不会自动重发');
  await expect(page.locator('.message.user')).toHaveCount(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { interruptedSends: string[] }).interruptedSends.length,
    ),
  ).toBe(1);
});
