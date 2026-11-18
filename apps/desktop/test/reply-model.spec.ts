import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { EventPayload, Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

// A session of finished turns, each answered by the model given (none: recorded before replies named one).
async function open(page: Page, models: (string | undefined)[], subagentModel?: string) {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '换过模型',
    autoTitle: false,
    projectPath: 'D:\\工作\\模型',
    permissionMode: 'default',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  let sequence = 0;
  const events = models.flatMap((model, turn) => {
    const runId = randomUUID();
    const payloads: EventPayload[] = [
      { type: 'message.user', messageId: randomUUID(), text: `问题 ${turn + 1}`, scenario: 'chat' },
      ...(subagentModel
        ? ([
            {
              type: 'tool.requested',
              toolId: `agent-${turn}`,
              name: 'Agent',
              input: '{}',
              target: 'Linux',
            },
            {
              type: 'text.delta',
              messageId: randomUUID(),
              text: '子代理的话',
              parentToolId: `agent-${turn}`,
              model: subagentModel,
            },
            {
              type: 'tool.result',
              toolId: `agent-${turn}`,
              status: 'completed',
              output: '好',
              exitCode: 0,
            },
          ] as EventPayload[])
        : []),
      {
        type: 'text.delta',
        messageId: randomUUID(),
        text: `回答 ${turn + 1}`,
        ...(model ? { model } : {}),
      },
      { type: 'run.status', status: 'completed', connectionId: randomUUID() },
    ];
    return payloads.map((payload) => ({
      sessionId: session.id,
      runId,
      sequence: ++sequence,
      createdAt: new Date(Date.now() - (100 - sequence) * 1000).toISOString(),
      payload,
    }));
  });
  await page.routeWebSocket('ws://127.0.0.1:18897/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [session],
        });
      if (message.type === 'session.subscribe')
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: false,
          events,
        });
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18897/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-reply-model-token-long');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.message.assistant').last()).toContainText(`回答 ${models.length}`);
}

test('where models changed, each reply names its own beside its time', async ({ page }) => {
  await open(page, ['claude-opus-4-7', 'claude-sonnet-4-6', undefined]);
  const labels = page.locator('.message.assistant .message-model');
  await expect(labels).toHaveText(['模型 Opus 4.7', '模型 Sonnet 4.6']);
  await expect(labels.first()).toHaveAttribute('title', 'claude-opus-4-7');
  await page.screenshot({ path: resolve(screenshots, 'reply-model.png') });
});

test('one model throughout, and sessions from before, name none', async ({ page }) => {
  await open(page, ['claude-opus-4-7', 'claude-opus-4-7-20260101', undefined]);
  await expect(page.locator('.message.assistant')).toHaveCount(3);
  await expect(page.locator('.message-model')).toHaveCount(0);
});

test('a subagent on another model does not make replies name theirs', async ({ page }) => {
  await open(page, ['claude-opus-4-7', 'claude-opus-4-7'], 'claude-haiku-4-5');
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await expect(page.locator('.message-model')).toHaveCount(0);
});
