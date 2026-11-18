import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { EventPayload, Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

// A turn whose Agent call took `steps` steps, a word of the subagent's before every tenth. `placed: false` records
// them as sessions before protocol 25 did, side by side with the Agent call. `live` sends the steps after the
// history, as a run sends them.
function agentTurn(steps: number, placed = true) {
  const agent = 'agent-call';
  const payloads: EventPayload[] = [
    { type: 'message.user', messageId: randomUUID(), text: '看看项目', scenario: 'chat' },
    {
      type: 'tool.requested',
      toolId: agent,
      name: 'Agent',
      input: JSON.stringify({ description: '查看结构', prompt: '看' }),
      target: 'Linux',
    },
  ];
  for (let step = 1; step <= steps; step++) {
    // Before protocol 25 a subagent's words were not sent at all.
    if (placed && step % 10 === 1)
      payloads.push({
        type: 'text.delta',
        messageId: randomUUID(),
        text: `子代理说明 ${step}`,
        ...(placed ? { parentToolId: agent } : {}),
      });
    const toolId = `read-${step}`;
    payloads.push(
      {
        type: 'tool.requested',
        toolId,
        name: 'Read',
        input: JSON.stringify({ file_path: `/w/file-${step}.txt` }),
        target: 'Linux',
        ...(placed ? { parentToolId: agent } : {}),
      },
      { type: 'tool.result', toolId, status: 'completed', output: `内容 ${step}`, exitCode: 0 },
    );
  }
  payloads.push({
    type: 'tool.result',
    toolId: agent,
    status: 'completed',
    output: '看完了',
    exitCode: 0,
  });
  return payloads;
}

async function open(page: Page, payloads: EventPayload[], live = 0, ended = true) {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '子代理',
    autoTitle: false,
    projectPath: 'D:\\工作\\子代理',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: { id: runId, status: 'running', connectionId },
  };
  let sequence = 0;
  const events = payloads.map((payload) => ({
    sessionId: session.id,
    runId,
    sequence: ++sequence,
    createdAt: new Date().toISOString(),
    payload,
  }));
  const history = (live ? events.slice(0, 2) : events).filter(
    (event) =>
      ended || event.payload.type !== 'tool.result' || event.payload.toolId !== 'agent-call',
  );
  await page.routeWebSocket('ws://127.0.0.1:18895/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
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
          lastSequence: history.length,
          hasEarlier: false,
          events: history,
        });
        reply({ type: 'response', requestId: message.requestId, ok: true });
        // As the service sends them: what comes in pieces first as a fragment, then recorded once the piece is over.
        if (live)
          setTimeout(() => {
            for (const event of events.slice(2)) {
              if (event.payload.type === 'text.delta' || event.payload.type === 'thinking.delta')
                reply({
                  type: 'session.fragment',
                  sessionId: session.id,
                  runId,
                  payload: event.payload,
                });
              reply({ type: 'session.event', event });
            }
          }, 200);
        return;
      }
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18895/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-subagent-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
}

// Opens the step and the Agent call; the subagent's fold is left as it is.
async function openAgent(page: Page) {
  const work = page.locator('details.work').first();
  await work.locator(':scope > summary').click();
  const agent = work.locator('details.tool').first();
  await agent.locator(':scope > summary').click();
  return agent;
}

test('a subagent’s steps fold under its call, 25 at first and the rest on demand', async ({
  page,
}) => {
  await open(page, agentTurn(40));
  const agent = await openAgent(page);
  // The step holds the Agent call alone; its subagent's calls are under it.
  await expect(page.locator('details.work').first().locator(':scope > details.tool')).toHaveCount(
    1,
  );
  const steps = agent.locator('details.subagent-steps');
  await expect(steps.locator(':scope > summary')).toContainText('子代理过程 · 40 次调用，4 段说明');
  await expect(steps.locator('details.tool')).toHaveCount(0);
  await steps.locator(':scope > summary').click();
  const list = steps.locator('.subagent-steps-list');
  await expect(list.locator(':scope > *:not(.subagent-more)')).toHaveCount(25);
  await expect(list.locator('.subagent-words').first()).toContainText('子代理说明 1');
  const more = list.locator('.subagent-more');
  await expect(more).toHaveText('再显示 19 步（还有 19 步）');
  await page.screenshot({ path: resolve(screenshots, 'subagent-steps.png') });
  await more.click();
  await expect(list.locator('details.tool')).toHaveCount(40);
  await expect(more).toHaveCount(0);
});

test('steps that come live read the same as the same steps from history', async ({ page }) => {
  const payloads = agentTurn(12);
  const read = async () => {
    const agent = await openAgent(page);
    const steps = agent.locator('details.subagent-steps');
    await steps.locator(':scope > summary').click();
    await expect(steps.locator('details.tool')).toHaveCount(12);
    return steps.locator('.subagent-steps-list').innerText();
  };
  await open(page, payloads, 1);
  await expect(page.locator('details.work')).toHaveCount(1);
  const live = await read();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await open(page, payloads);
  expect(await read()).toBe(live);
});

test('hundreds of steps make nothing until opened, and no more than 25 when opened', async ({
  page,
}) => {
  await open(page, agentTurn(300));
  const agent = await openAgent(page);
  await expect(agent.locator('.subagent-steps-list')).toHaveCount(0);
  await agent.locator('details.subagent-steps > summary').click();
  await expect(agent.locator('.subagent-steps-list > :not(.subagent-more)')).toHaveCount(25);
});

test('steps recorded before protocol 25 stay side by side with the Agent call', async ({
  page,
}) => {
  await open(page, agentTurn(3, false));
  const work = page.locator('details.work').first();
  await work.locator(':scope > summary').click();
  await expect(work.locator(':scope > details.tool')).toHaveCount(4);
  await expect(page.locator('details.subagent-steps')).toHaveCount(0);
});

test('a subagent at work shows its latest steps, and earlier ones on demand', async ({ page }) => {
  await open(page, agentTurn(40), 0, false);
  const agent = await openAgent(page);
  const steps = agent.locator('details.subagent-steps');
  await steps.locator(':scope > summary').click();
  const list = steps.locator('.subagent-steps-list');
  const more = list.locator('.subagent-more');
  await expect(more).toHaveText('显示更早的 19 步（还有 19 步）');
  await expect(list.locator(':scope > details.tool').last()).toContainText('file-40.txt');
  await expect(list.locator(':scope > details.tool').first()).toContainText('file-18.txt');
  await more.click();
  await expect(list.locator(':scope > details.tool')).toHaveCount(40);
});

test('what a subagent says while it streams is under its call, and its answer is shown once', async ({
  page,
}) => {
  const payloads = agentTurn(2);
  // Its last words are its answer, the Agent call's output.
  payloads.splice(-1, 0, {
    type: 'text.delta',
    messageId: randomUUID(),
    text: '看完了',
    parentToolId: 'agent-call',
  });
  await open(page, payloads, 1);
  const agent = await openAgent(page);
  const steps = agent.locator('details.subagent-steps');
  await expect(steps.locator(':scope > summary')).toContainText('2 次调用，1 段说明');
  await steps.locator(':scope > summary').click();
  await expect(steps.locator('.subagent-words')).toHaveText(['子代理说明 1']);
  await expect(page.locator('.message.assistant')).toHaveCount(0);
});
