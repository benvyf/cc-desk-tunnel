import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { EventPayload, Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import {
  installPerformanceProbe,
  percentile,
  readPerformanceProbe,
  resetPerformanceProbe,
} from './fixtures/conversation-performance.ts';

// A long session: 200 finished turns, each a question, ten steps (one of them writes a file the answer names) and
// an answer of about 1 KB of Markdown with inline and display math, a table and code. Then a 201st turn streams 300
// pieces of text, 16 ms apart, while the measures run. The hard check is a count: no finished answer renders
// (parses its Markdown) again while the new one streams. Times are only a loose backstop and recorded.
const TURNS = 200;
const PIECES = 300;
const address = 'ws://127.0.0.1:18931/ws';

const answer = (n: number) => `## 第 ${n} 轮的结论

已修改 \`src/module${n}.ts\`，其中 $E = mc^2$ 与 $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$ 都已核对。

$$
\\int_0^1 x^${(n % 5) + 1}\\,dx = \\frac{1}{${(n % 5) + 2}}
$$

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 类型检查 | 通过 | 第 ${n} 轮 |
| 单元测试 | ${100 + n} 项通过 | 无失败 |
| 格式 | 已整理 | prettier |

\`\`\`ts
export function module${n}(value: number) {
  return value * ${n} + Math.sqrt(value);
}
\`\`\`

- 第一点：保持原有接口不变。
- 第二点：**新增**一个参数，默认值与原来一致。
- 第三点：见 [说明](https://example.com/docs/${n})。

最后，module${n}.ts 的修改已经完成。`;

function fixture() {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '长会话性能',
    autoTitle: false,
    projectPath: 'D:\\perf\\long',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const events: SessionEvent[] = [];
  const add = (runId: string, payload: EventPayload) => {
    const event: SessionEvent = {
      sessionId: session.id,
      runId,
      sequence: events.length + 1,
      createdAt: now,
      payload,
    };
    events.push(event);
    return event;
  };
  for (let n = 1; n <= TURNS; n++) {
    const runId = randomUUID();
    add(runId, {
      type: 'message.user',
      messageId: randomUUID(),
      text: `第 ${n} 个问题`,
      scenario: 'chat',
    });
    add(runId, { type: 'run.status', status: 'running', connectionId });
    add(runId, { type: 'text.delta', messageId: randomUUID(), text: `先看一下第 ${n} 个模块。` });
    for (let step = 0; step < 10; step++) {
      const toolId = `t${n}-${step}`;
      const write = step === 9;
      add(runId, {
        type: 'tool.requested',
        toolId,
        name: write ? 'Write' : 'Read',
        input: JSON.stringify(
          write
            ? { file_path: `D:\\perf\\long\\src\\module${n}.ts`, content: 'export {};' }
            : { file_path: `D:\\perf\\long\\src\\file${step}.ts` },
        ),
        target: 'Windows',
      });
      add(runId, {
        type: 'tool.result',
        toolId,
        status: 'completed',
        output: write ? 'File written' : `line 1\nline 2\nline ${step}`,
        exitCode: null,
      });
    }
    add(runId, { type: 'text.delta', messageId: randomUUID(), text: answer(n) });
    add(runId, { type: 'run.status', status: 'completed', connectionId });
  }
  return { session, events, add, connectionId };
}

// Opens the long session in a window whose desktop bridge and service are faked, and waits for it to settle.
async function openLong(page: Page) {
  await installPerformanceProbe(page);
  await page.addInitScript(() => {
    const counts = ((window as any).richTextRenders = {
      finished: 0,
      streaming: 0,
      turns: 0,
      settled: 0,
    });
    (globalThis as any).ccPerf = {
      richText: (streaming: boolean) => {
        if (streaming) counts.streaming++;
        else counts.finished++;
      },
      turn: () => counts.turns++,
      settled: () => counts.settled++,
    };
    localStorage.setItem('proxy-prefs', JSON.stringify({ view: { mode: 'standard' } }));
  });
  // The desktop bridge, faked as in conversation-performance.spec.ts: no Electron IPC, files, server or model.
  await page.addInitScript(() => {
    const noop = async () => {};
    const listener = () => () => {};
    (window as any).desktop = {
      dev: true,
      platform: 'win32',
      version: async () => '0.0.1',
      boot: { connection: '', shared: { connections: [], busy: [] } },
      device: async () => ({ id: 'performance-device', name: 'Performance fixture' }),
      loadLogin: async () => null,
      saveLogin: noop,
      disconnectProxy: noop,
      connectProxy: async () => ({ url: 'ws://127.0.0.1:18931/ws' }),
      workspaceRoots: async () => [],
      foldersExist: async (folders: string[]) => folders.map(() => true),
      setBusy: noop,
      saveShared: noop,
      onSharedChanged: listener,
      onNotifyClicked: listener,
      onUpdateProgress: listener,
      onSchedulesChanged: listener,
      loadSchedules: async () => ({ path: '', text: '' }),
      notify: noop,
      gitBranch: async () => null,
      copyText: noop,
      openLink: noop,
      preview: {
        list: async () => [],
        pick: async () => null,
        read: async ({ path }: { path: string }) => ({ path, kind: 'text', text: '' }),
        watch: noop,
        unwatch: noop,
        onChanged: listener,
        onState: listener,
        releaseFile: noop,
        release: noop,
        bounds: noop,
        hide: noop,
      },
    };
  });
  const { session, events, add, connectionId } = fixture();
  let send = (_value: unknown) => {};
  await page.routeWebSocket(address, (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill(address);
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('long-session-performance-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  const opened = Date.now();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.message.assistant')).toHaveCount(TURNS, { timeout: 120_000 });
  await expect(page.locator('.message.assistant').last()).toContainText(`第 ${TURNS} 轮的结论`);
  const openMs = Date.now() - opened;
  // Let what opening the session started settle before counting.
  await page.waitForTimeout(1500);
  return { session, add, send: (value: unknown) => send(value), connectionId, openMs };
}
test('a long session streams without parsing its finished answers again', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const { session, add, send, connectionId, openMs } = await openLong(page);

  const runId = randomUUID(),
    messageId = randomUUID();
  session.activeRun = { id: runId, connectionId, status: 'running' };
  send({ type: 'session.updated', session });
  send({
    type: 'session.event',
    event: add(runId, {
      type: 'message.user',
      messageId: randomUUID(),
      text: '再来一轮',
      scenario: 'chat',
    }),
  });
  send({
    type: 'session.event',
    event: add(runId, { type: 'run.status', status: 'running', connectionId }),
  });
  await expect(page.locator('.message.user').last()).toContainText('再来一轮');
  await page.waitForTimeout(500);
  await page.evaluate(() =>
    Object.assign((window as any).richTextRenders, {
      finished: 0,
      streaming: 0,
      turns: 0,
      settled: 0,
    }),
  );
  await resetPerformanceProbe(page);
  await page.evaluate(() => {
    const frames: number[] = ((window as any).frameGaps = []);
    let last = performance.now();
    const tick = (now: number) => {
      frames.push(now - last);
      last = now;
      if ((window as any).frameGaps === frames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const piece = (n: number) =>
    n % 100 === 50
      ? '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- 一\n- 二\n\n$\nx^2\n\n+ 1\n$\n\n'
      : `第 ${n} 段：继续说明 $x_${n}$ 的取值，并补充一个 **要点**。${n % 20 === 19 ? '\n\n' : ''}`;
  const began = Date.now();
  for (let n = 0; n < PIECES; n++) {
    send({
      type: 'session.fragment',
      sessionId: session.id,
      runId,
      payload: { type: 'text.delta', messageId, text: piece(n) },
    });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await expect(page.locator('.message.assistant').last()).toContainText(`第 ${PIECES - 1} 段`, {
    timeout: 60_000,
  });
  const streamMs = Date.now() - began;
  const renders = await page.evaluate(() => ({ ...(window as any).richTextRenders }));
  const frameGaps: number[] = await page.evaluate(() => {
    const frames = (window as any).frameGaps;
    (window as any).frameGaps = null;
    return frames;
  });
  const probe = await readPerformanceProbe(page);
  const result = {
    turns: TURNS,
    pieces: PIECES,
    openMs,
    streamMs,
    renders,
    frames: frameGaps.length,
    frameGapP95: percentile(frameGaps, 0.95),
    frameGapMax: Math.max(...frameGaps),
    longTasks: probe.longTasks.length,
    longTaskP95: percentile(probe.longTasks, 0.95),
    longTaskTotal: probe.longTasks.reduce((sum, value) => sum + value, 0),
  };
  const path = info.outputPath('long-session-performance.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('long-session-performance', { path, contentType: 'application/json' });
  console.log('long-session-performance', JSON.stringify(result));

  // The count is the gate: what streams is the new answer only.
  expect(renders.finished).toBe(0);
  expect(renders.streaming).toBeGreaterThan(0);
  // Only the turn at work draws again, about once a flush; each settled block is parsed about once.
  expect(renders.turns).toBeLessThanOrEqual(renders.streaming * 2 + 10);
  expect(renders.settled).toBeLessThanOrEqual(2 * Math.ceil(PIECES / 20) + 20);
  // Loose backstops, for a machine under other load: frames keep coming while it streams. A development build
  // (the usual test server) draws about five times slower than a release; its budget only catches the seconds-long
  // stalls this test was written for.
  const development = await page.evaluate(
    () => !!document.querySelector('script[src*="@vite/client"]'),
  );
  expect(result.frameGapP95).toBeLessThanOrEqual(development ? 1000 : 100);
  expect(result.longTaskP95).toBeLessThanOrEqual(development ? 1500 : 250);
});

test('find keeps its matches across a long session while a new answer streams in', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { session, add, send, connectionId } = await openLong(page);
  await page.keyboard.press('Control+f');
  await page.getByLabel('查找对话内容', { exact: true }).fill('结论');
  const count = page.locator('.find-count');
  // Each finished answer is headed "第 n 轮的结论".
  await expect(count).toHaveText(new RegExp(`^1 / ${TURNS}`), { timeout: 60_000 });
  const runId = randomUUID(),
    messageId = randomUUID();
  session.activeRun = { id: runId, connectionId, status: 'running' };
  send({ type: 'session.updated', session });
  send({
    type: 'session.event',
    event: add(runId, {
      type: 'message.user',
      messageId: randomUUID(),
      text: '再来一轮',
      scenario: 'chat',
    }),
  });
  send({
    type: 'session.event',
    event: add(runId, { type: 'run.status', status: 'running', connectionId }),
  });
  for (let n = 0; n < 30; n++) {
    send({
      type: 'session.fragment',
      sessionId: session.id,
      runId,
      payload: {
        type: 'text.delta',
        messageId,
        text: `第 ${n} 条结论。${n % 10 === 9 ? '\n\n' : ''}`,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  // The new answer's matches join, the earlier ones stay, and the current one is kept.
  await expect(count).toHaveText(new RegExp(`^1 / ${TURNS + 30}`), { timeout: 30_000 });
  await page.getByLabel('查找对话内容', { exact: true }).press('Enter');
  await expect(count).toHaveText(new RegExp(`^2 / ${TURNS + 30}`));
  await page.getByLabel('查找对话内容', { exact: true }).fill('条结论');
  await expect(count).toHaveText(/^1 \/ 30/);
});
