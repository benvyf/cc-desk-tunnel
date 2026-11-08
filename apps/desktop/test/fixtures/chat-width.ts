import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type Session,
  type SessionEvent,
  type EventPayload,
} from '@cc-desk-tunnel/protocol';

export async function chatWidthFixture(page: Page, turns = 4) {
  const now = new Date().toISOString(),
    connectionId = randomUUID();
  const main: Session = {
    id: randomUUID(),
    title: '宽度测试主会话',
    projectPath: 'D:/width-fixture',
    autoTitle: false,
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const sessions = [main, { ...main, id: randomUUID(), title: '宽度测试第二会话' }];
  const events = new Map<string, SessionEvent[]>(sessions.map((session) => [session.id, []]));
  const calls: any[] = [];
  let send = (_value: unknown) => {};
  function add(sessionId: string, runId: string, payload: EventPayload) {
    const list = events.get(sessionId)!;
    const event: SessionEvent = {
      sessionId,
      runId,
      sequence: list.length + 1,
      createdAt: now,
      payload,
    };
    list.push(event);
    return event;
  }
  for (const session of sessions)
    for (let index = 0; index < turns; index++) {
      const runId = randomUUID();
      add(session.id, runId, {
        type: 'message.user',
        messageId: randomUUID(),
        text: `问题 ${index} 如何调节聊天正文宽度？`,
        scenario: 'chat',
      });
      add(session.id, runId, {
        type: 'text.delta',
        messageId: randomUUID(),
        text: `回答 ${index}\n\n` + '这是一段用来检查正文换行、引用和宽度联动的文字。'.repeat(20),
      });
      add(session.id, runId, { type: 'run.status', status: 'completed', connectionId });
    }
  await page.routeWebSocket('ws://127.0.0.1:18923/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      calls.push(message);
      const respond = (sessionId = message.sessionId) =>
        send({ type: 'response', requestId: message.requestId, ok: true, sessionId });
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          adapter: 'claude-code',
          connectionId,
          sessions,
          sideConversations: true,
        });
      if (message.type === 'session.subscribe') {
        const session = sessions.find((s) => s.id === message.sessionId)!;
        const list = events.get(session.id)!;
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: list.length,
          hasEarlier: false,
          events: list,
        });
        return respond();
      }
      if (message.type === 'session.side.create') {
        const child: Session = {
          ...main,
          id: randomUUID(),
          title: message.title,
          sideConversation: {
            parentSessionId: main.id,
            throughSequence: events.get(main.id)!.length,
            createdAt: now,
          },
        };
        sessions.push(child);
        events.set(
          child.id,
          [...events.get(main.id)!].map((e) => ({ ...e, sessionId: child.id })),
        );
        send({ type: 'session.updated', session: child });
        return respond(child.id);
      }
      respond();
    });
  });
  await page.goto('/');
  const local = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await local.isVisible()) await local.click();
  await page.getByLabel('服务地址').fill('ws://127.0.0.1:18923/ws');
  await page.getByLabel('服务凭据').fill('width-fixture-token-with-enough-characters');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page
    .locator('.session-row')
    .filter({ hasText: main.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.workspace .message.assistant').last()).toContainText(
    `回答 ${turns - 1}`,
  );
  return {
    calls,
    start() {
      const runId = randomUUID(),
        messageId = randomUUID();
      main.activeRun = { id: runId, status: 'running', connectionId };
      send({ type: 'session.updated', session: main });
      send({
        type: 'session.event',
        event: add(main.id, runId, {
          type: 'message.user',
          messageId: randomUUID(),
          text: '继续流式输出',
          scenario: 'chat',
        }),
      });
      return {
        fragment: (text: string) =>
          send({
            type: 'session.event',
            event: add(main.id, runId, { type: 'text.delta', messageId, text }),
          }),
      };
    },
  };
}
