import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { EventPayload, Session } from '@cc-desk-tunnel/protocol';

// A long session whose replies differ in height: lists, code and tables, so that what the page guesses for a
// reply not yet drawn is off, and the view must keep to its end while the real heights come in.
const turns = 60;

function reply(n: number) {
  const lines = Array.from(
    { length: (n % 7) + 2 },
    (_, i) => `- 第${n}轮的第${i + 1}点，说明写得长一些，好让它在窗口里换行。`,
  );
  const code = Array.from({ length: (n % 5) * 3 }, (_, i) => `echo ${n}-${i}`).join('\n');
  return [
    `第${n}轮的回答。`,
    ...lines,
    code ? '```sh\n' + code + '\n```' : '',
    `| 列 | 值 |\n| --- | --- |\n| ${n} | ${n * 2} |`,
  ].join('\n\n');
}

// Opens the session; what is returned starts a reply streaming into it, fast, and stops it when called.
async function open(
  page: Page,
  folding = false,
  scenario?: 'history' | 'short-history' | 'layout',
) {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  let stream = () => ({ stop: () => {}, complete: () => {}, steer: () => {} });
  let earlierRequests = 0;
  let releaseEarlier: () => void = () => {
    throw new Error('Earlier history has not been requested');
  };
  const session: Session = {
    id: randomUUID(),
    title: '长对话',
    autoTitle: false,
    projectPath: 'D:\\工作\\长对话',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    let sequence = 0;
    const start = Date.now() - 3_600_000;
    const events: unknown[] = [];
    for (let n = 0; n < turns; n++) {
      const runId = randomUUID();
      const event = (payload: unknown) => ({
        sessionId: session.id,
        runId,
        sequence: ++sequence,
        createdAt: new Date(start + sequence * 1000).toISOString(),
        payload,
      });
      events.push(
        event({
          type: 'message.user',
          messageId: randomUUID(),
          text: `第${n}问`,
          scenario: 'chat',
        }),
        event({
          type: 'tool.requested',
          toolId: `t${n}`,
          name: 'Bash',
          input: JSON.stringify({ command: 'ls', description: `看一看${n}` }),
          target: 'Windows',
        }),
        event({
          type: 'tool.result',
          toolId: `t${n}`,
          status: 'completed',
          output: 'a',
          exitCode: 0,
        }),
        event({
          type: 'text.delta',
          messageId: randomUUID(),
          text:
            (scenario === 'short-history' && n === turns - 1 ? '较短的已加载回答' : reply(n)) +
            (scenario === 'layout' && n === turns - 1
              ? '\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="320" height="24"><rect width="320" height="24" fill="green"/></svg>\n```'
              : ''),
        }),
        event({ type: 'run.status', status: 'completed', connectionId }),
      );
    }
    stream = () => {
      const runId = randomUUID();
      let messageId = randomUUID();
      const emit = (payload: EventPayload) =>
        send({
          type: 'session.event',
          event: {
            sessionId: session.id,
            runId,
            sequence: ++sequence,
            createdAt: new Date().toISOString(),
            payload,
          },
        });
      session.activeRun = { id: runId, status: 'running', connectionId };
      send({ type: 'session.updated', session });
      emit({
        type: 'message.user',
        messageId: randomUUID(),
        text: '开始新的流式回答',
        scenario: 'chat',
      });
      emit({ type: 'run.status', status: 'running', connectionId });
      if (folding)
        for (let i = 0; i < 8; i++) {
          const toolId = randomUUID();
          emit({
            type: 'tool.requested',
            toolId,
            name: 'Bash',
            input: JSON.stringify({ command: 'ls', description: `折叠步骤${i}` }),
            target: 'Windows',
          });
          emit({ type: 'tool.result', toolId, status: 'completed', output: 'a', exitCode: 0 });
          emit({
            type: 'text.delta',
            messageId: randomUUID(),
            text:
              `折叠前的过程说明${i}。\n\n` +
              '保持过程文本足够高以覆盖折叠时的实际布局变化。'.repeat(8),
          });
        }
      let n = 0;
      const timer = setInterval(() => {
        send({
          type: 'session.event',
          event: {
            sessionId: session.id,
            runId,
            sequence: ++sequence,
            createdAt: new Date().toISOString(),
            payload: {
              type: 'text.delta',
              messageId,
              text: `\n\n流式输出第${++n}段，写得长一些，好让它在窗口里换行，页面跟着变高。`,
            },
          },
        });
      }, 20);
      const stop = () => clearInterval(timer);
      return {
        stop,
        complete: () => {
          stop();
          emit({ type: 'run.status', status: 'completed', connectionId });
          session.activeRun = null;
          send({ type: 'session.updated', session });
        },
        steer: () => {
          emit({
            type: 'message.user',
            messageId: randomUUID(),
            text: '补充问题保持同一个运行标识',
            scenario: 'chat',
          });
          messageId = randomUUID();
        },
      };
    };
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
          firstSequence: scenario === 'history' ? 51 : scenario === 'short-history' ? 296 : 1,
          lastSequence: sequence,
          hasEarlier: scenario === 'history' || scenario === 'short-history',
          events:
            scenario === 'history'
              ? events.slice(50)
              : scenario === 'short-history'
                ? events.slice(-5)
                : events,
        });
      if (message.type === 'session.history') {
        earlierRequests++;
        releaseEarlier = () => {
          send({
            type: 'session.snapshot',
            requestId: message.requestId,
            session,
            mode: 'prepend',
            firstSequence: 1,
            lastSequence: scenario === 'short-history' ? 295 : 50,
            hasEarlier: false,
            events: scenario === 'short-history' ? events.slice(0, -5) : events.slice(0, 50),
          });
          send({ type: 'response', requestId: message.requestId, ok: true });
        };
        return;
      }
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18894/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-view-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(
    page.getByText(scenario === 'short-history' ? '较短的已加载回答' : `第${turns - 1}轮的回答。`),
  ).toBeVisible();
  return Object.assign(() => stream(), {
    earlierRequests: () => earlierRequests,
    prepend: () => releaseEarlier(),
  });
}

// How far the view is from the end of the conversation, once it has stopped moving.
async function fromEnd(page: Page) {
  const conversation = page.locator('.conversation');
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const now = await conversation.evaluate((box) => box.scrollTop);
    if (now === last) break;
    last = now;
  }
  return conversation.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight);
}

type FollowFrame = {
  gap: number;
  anchorTop: number | null;
  scrollTop: number;
  answerTop: number | null;
};
async function startFrames(page: Page, readingUp: boolean) {
  await page.evaluate((readingUp) => {
    const box = document.querySelector<HTMLElement>('.conversation')!;
    const anchor = readingUp ? box.querySelector<HTMLElement>('[data-follow-anchor]') : undefined;
    const answer = box.querySelector<HTMLElement>('[data-collapse-answer]');
    if (readingUp && !anchor) throw new Error('The selected historical message is missing');
    const state = ((window as any).followFrames = { running: true, frames: [] as FollowFrame[] });
    const sample = () => {
      if (!state.running) return;
      state.frames.push({
        gap: box.scrollHeight - box.scrollTop - box.clientHeight,
        anchorTop: anchor?.isConnected ? anchor.getBoundingClientRect().top : null,
        scrollTop: box.scrollTop,
        answerTop: answer?.isConnected ? answer.getBoundingClientRect().top : null,
      });
      requestAnimationFrame(sample);
    };
    sample();
  }, readingUp);
}

async function stopFrames(page: Page, testInfo: TestInfo) {
  await page.waitForTimeout(500);
  const frames = await page.evaluate(() => {
    (window as any).followFrames.running = false;
    return (window as any).followFrames.frames as FollowFrame[];
  });
  const path = testInfo.outputPath('scroll-frames.json');
  await writeFile(path, JSON.stringify(frames, null, 2));
  await testInfo.attach('scroll-frames.json', { path, contentType: 'application/json' });
  expect(frames.length).toBeGreaterThan(5);
  return frames;
}

function expectStableAnchor(frames: FollowFrame[]) {
  expect(frames.every((frame) => frame.anchorTop !== null)).toBe(true);
  const top = frames[0].anchorTop!;
  expect(Math.max(...frames.map((frame) => Math.abs(frame.anchorTop! - top)))).toBeLessThanOrEqual(
    2,
  );
}

test('a long conversation opens at its end', async ({ page }) => {
  await open(page);
  expect(await fromEnd(page)).toBeLessThan(2);
});

test('coming back from the settings, the conversation is at its end again', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(page.getByText(`第${turns - 1}轮的回答。`)).toBeVisible();
  expect(await fromEnd(page)).toBeLessThan(2);
});

test('a resized window keeps to the end, and one read further up stays where it is', async ({
  page,
}) => {
  await open(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  expect(await fromEnd(page)).toBeLessThan(2);
  const conversation = page.locator('.conversation');
  await conversation.hover();
  await page.mouse.wheel(0, -1500);
  const before = await fromEnd(page);
  expect(before).toBeGreaterThan(500);
  await page.setViewportSize({ width: 1100, height: 760 });
  expect(await fromEnd(page)).toBeGreaterThan(300);
});

test('opening the steps of the last turn does not pull them out of sight', async ({ page }) => {
  await open(page);
  expect(await fromEnd(page)).toBeLessThan(2);
  const summary = page.locator('.turn-process > summary').last();
  await summary.click();
  await expect(page.locator('.turn-process').last()).toHaveAttribute('open', '');
  await fromEnd(page);
  await expect(summary).toBeInViewport();
});

test('while output streams in fast, a reader scrolling up a little is not pulled back to the end', async ({
  page,
}) => {
  const stream = await open(page);
  const conversation = page.locator('.conversation');
  const back = page.getByRole('button', { name: '回到底部', exact: true });
  expect(await fromEnd(page)).toBeLessThan(2);
  await expect(back).toHaveCount(0);
  const { stop } = stream();
  await page.waitForTimeout(300);
  // One notch at a time, slower than the output comes in.
  await conversation.hover();
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(800);
  const read = await conversation.evaluate((box) => box.scrollTop);
  await page.waitForTimeout(500);
  expect(await conversation.evaluate((box) => box.scrollTop)).toBe(read);
  await expect(back).toBeVisible();
  // The button brings the view down, and it follows the output from there.
  await back.click();
  await expect(back).toHaveCount(0);
  await page.waitForTimeout(500);
  stop();
  expect(await fromEnd(page)).toBeLessThan(2);
  // Scrolling all the way down by hand follows again as well. Each turn of the wheel goes past where the end is as
  // it is taken: a fixed step would never get there on a machine slow enough that the page grows faster than it.
  const { stop: again } = stream();
  await page.mouse.wheel(0, -400);
  await expect(back).toBeVisible();
  for (let i = 0; i < 20 && (await back.count()); i++) {
    const gap = await conversation.evaluate(
      (box) => box.scrollHeight - box.scrollTop - box.clientHeight,
    );
    await page.mouse.wheel(0, gap + 400);
    await page.waitForTimeout(100);
  }
  await expect(back).toHaveCount(0);
  await page.waitForTimeout(500);
  again();
  expect(await fromEnd(page)).toBeLessThan(2);
});

for (const action of ['complete', 'steer'] as const) {
  for (const readingUp of [false, true]) {
    test(`${action} preserves frame position · ${readingUp ? 'reading history' : 'following'}`, async ({
      page,
    }, testInfo) => {
      const start = await open(page, true);
      const controls = start();
      try {
        await page.waitForTimeout(500);
        expect(await fromEnd(page)).toBeLessThan(2);
        if (readingUp) {
          const anchor = page
            .locator('.conversation .message.user')
            .filter({ hasText: `第${turns - 2}问` });
          await anchor.scrollIntoViewIfNeeded();
          await anchor.evaluate((node) => {
            node.setAttribute('data-follow-anchor', 'true');
          });
          await anchor.hover();
          await page.mouse.wheel(0, -80);
          expect(await fromEnd(page)).toBeGreaterThan(500);
          await expect(anchor).toBeInViewport();
        }
        const foldedBefore = await page.locator('.turn-process').count();
        await startFrames(page, readingUp);
        controls[action]();
        // Completed work folds. A question added to the same run keeps its preceding process held
        // open until the run ends; steering must preserve that existing behavior.
        await expect(page.locator('.turn-process')).toHaveCount(
          foldedBefore + (action === 'complete' ? 1 : 0),
        );
        if (action === 'steer')
          await expect(
            page.locator('.message.user.joined').filter({ hasText: '补充问题保持同一个运行标识' }),
          ).toHaveCount(1);
        const frames = await stopFrames(page, testInfo);
        if (readingUp) {
          expectStableAnchor(frames);
          await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
        } else {
          expect(Math.max(...frames.map((frame) => frame.gap))).toBeLessThan(2);
          await expect(page.getByRole('button', { name: '回到底部', exact: true })).toHaveCount(0);
        }
      } finally {
        controls.stop();
      }
    });
  }
}

test('collapsing tool output keeps its disclosure fixed without pulling the reader to the bottom', async ({
  page,
}, testInfo) => {
  await open(page);
  const process = page.locator('.turn-process').last();
  await process.locator(':scope > summary').click();
  const work = process.locator('.work');
  await work.locator(':scope > summary').click();
  const tool = work.locator('.tool');
  const summary = tool.locator(':scope > summary');
  await summary.click();
  await expect(tool).toHaveAttribute('open', '');
  // The disclosure and the answer below it both fit. Removing the output intentionally raises the
  // answer; the clicked disclosure should stay put, with no bottom-follow or oscillation.
  await summary.evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.locator('.conversation').hover();
  await page.mouse.wheel(0, -80);
  await fromEnd(page);
  const anchor = page.locator('.conversation .message.assistant').last();
  await expect(summary).toBeInViewport();
  await expect(anchor).toBeInViewport();
  await summary.evaluate((node) => node.setAttribute('data-follow-anchor', 'true'));
  await anchor.evaluate((node) => node.setAttribute('data-collapse-answer', 'true'));
  const snapshot = () =>
    page.evaluate(() => {
      const box = document.querySelector<HTMLElement>('.conversation')!;
      const bounds = box.getBoundingClientRect();
      const first = [...box.querySelectorAll<HTMLElement>('.message')].find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      return {
        viewport: { top: bounds.top, bottom: bounds.bottom },
        scrollTop: box.scrollTop,
        summaryTop: box.querySelector('[data-follow-anchor]')!.getBoundingClientRect().top,
        answerTop: box.querySelector('[data-collapse-answer]')!.getBoundingClientRect().top,
        firstVisibleMessage: first
          ? { text: first.textContent?.slice(0, 60), top: first.getBoundingClientRect().top }
          : null,
      };
    });
  const before = await snapshot();
  const expandedHeight = await tool.evaluate((node) => node.getBoundingClientRect().height);
  await startFrames(page, true);
  await summary.click();
  await expect(tool).not.toHaveAttribute('open', '');
  const collapsedHeight = await tool.evaluate((node) => node.getBoundingClientRect().height);
  expect(expandedHeight - collapsedHeight).toBeGreaterThan(50);
  const frames = await stopFrames(page, testInfo);
  const after = await snapshot();
  const path = testInfo.outputPath('tool-collapse-layout.json');
  await writeFile(
    path,
    JSON.stringify({ before, after, removedHeight: expandedHeight - collapsedHeight }, null, 2),
  );
  await testInfo.attach('tool-collapse-layout.json', { path, contentType: 'application/json' });
  expectStableAnchor(frames);
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2);
  expect(
    Math.abs(before.answerTop - after.answerTop - (expandedHeight - collapsedHeight)),
  ).toBeLessThanOrEqual(2);
  for (let index = 1; index < frames.length; index++)
    expect(frames[index].answerTop! - frames[index - 1].answerTop!).toBeLessThanOrEqual(2);
  await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
});

test('delayed Markdown image layout below a reader preserves their anchor in every frame', async ({
  page,
}, testInfo) => {
  await open(page, false, 'layout');
  const image = page.locator('.conversation img.code-picture');
  await expect(image).toHaveCount(1);
  await image.evaluate(async (node: HTMLImageElement) => {
    await node.decode();
  });
  const anchor = page
    .locator('.conversation .message.user')
    .filter({ hasText: `第${turns - 1}问` });
  await anchor.scrollIntoViewIfNeeded();
  await anchor.hover();
  await page.mouse.wheel(0, -80);
  await fromEnd(page);
  await expect(anchor).toBeInViewport();
  await anchor.evaluate((node) => node.setAttribute('data-follow-anchor', 'true'));
  const before = await image.evaluate((node) => node.getBoundingClientRect().height);
  expect(await image.evaluate((node) => node.getBoundingClientRect().top)).toBeGreaterThan(
    await anchor.evaluate((node) => node.getBoundingClientRect().bottom),
  );
  await startFrames(page, true);
  // An already-rendered Markdown drawing acquires a taller intrinsic size later, without a new
  // session event or focus change. This isolates the ResizeObserver/content-layout path.
  await image.evaluate(async (node: HTMLImageElement) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    node.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480"><rect width="320" height="480" fill="green"/></svg>')}`;
    await node.decode();
  });
  await expect
    .poll(
      async () => (await image.evaluate((node) => node.getBoundingClientRect().height)) - before,
    )
    .toBeGreaterThan(300);
  expectStableAnchor(await stopFrames(page, testInfo));
  await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
});

test('prepending earlier history preserves the first loaded question in every frame', async ({
  page,
}, testInfo) => {
  const fixture = await open(page, false, 'history');
  const anchor = page.locator('.conversation .message.user').filter({ hasText: '第10问' });
  const conversation = page.locator('.conversation');
  await conversation.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(fixture.earlierRequests).toBe(1);
  await expect(page.getByRole('button', { name: '加载中', exact: true })).toBeDisabled();
  await fromEnd(page);
  await expect(anchor).toBeInViewport();
  await anchor.evaluate((node) => node.setAttribute('data-follow-anchor', 'true'));
  const heightBefore = await conversation.evaluate((node) => node.scrollHeight);
  await startFrames(page, true);
  fixture.prepend();
  await expect(page.locator('.message.user').filter({ hasText: '第0问' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '加载中', exact: true })).toHaveCount(0);
  expect(await conversation.evaluate((node) => node.scrollHeight)).toBeGreaterThan(
    heightBefore + 1000,
  );
  expectStableAnchor(await stopFrames(page, testInfo));
  await expect(anchor).toBeInViewport();
  await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
});

test('scrolling while earlier history is pending keeps the newly chosen reading position', async ({
  page,
}, testInfo) => {
  const fixture = await open(page, false, 'history');
  const conversation = page.locator('.conversation');
  await conversation.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(fixture.earlierRequests).toBe(1);
  await expect(page.getByRole('button', { name: '加载中', exact: true })).toBeDisabled();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => conversation.evaluate((node) => node.scrollTop)).toBeGreaterThan(400);
  await fromEnd(page);
  const anchor = page.locator('.conversation .message.user').filter({ hasText: '第10问' });
  await anchor.evaluate((node) => node.setAttribute('data-follow-anchor', 'true'));
  await startFrames(page, true);
  fixture.prepend();
  await expect(page.getByRole('button', { name: '加载中', exact: true })).toHaveCount(0);
  expectStableAnchor(await stopFrames(page, testInfo));
  await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
});

test('returning to the bottom while earlier history is pending preserves following', async ({
  page,
}, testInfo) => {
  const fixture = await open(page, false, 'history');
  await page.locator('.conversation').hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(fixture.earlierRequests).toBe(1);
  const back = page.getByRole('button', { name: '回到底部', exact: true });
  await back.click();
  expect(await fromEnd(page)).toBeLessThan(2);
  const stream = fixture();
  try {
    await page.waitForTimeout(300);
    stream.stop();
    // Settle the final streamed layout before frame-sampling the history insertion.
    // The pending request must not freeze tail following during the preceding output.
    expect(await fromEnd(page)).toBeLessThan(2);
    await expect(back).toHaveCount(0);
    await startFrames(page, false);
    fixture.prepend();
    await expect(page.getByRole('button', { name: '加载中', exact: true })).toHaveCount(0);
    const frames = await stopFrames(page, testInfo);
    expect(Math.max(...frames.map((frame) => frame.gap))).toBeLessThan(2);
    await expect(back).toHaveCount(0);
  } finally {
    stream.stop();
  }
});

test('loading earlier history from a short page preserves reading instead of following its end', async ({
  page,
}, testInfo) => {
  const fixture = await open(page, false, 'short-history');
  const box = page.locator('.conversation');
  expect(await box.evaluate((node) => node.scrollHeight - node.clientHeight)).toBe(0);
  const anchor = box.locator('.message.user').filter({ hasText: '第59问' });
  await anchor.evaluate((node) => node.setAttribute('data-follow-anchor', 'true'));
  await box.hover();
  await page.mouse.wheel(0, -200);
  await expect.poll(fixture.earlierRequests).toBe(1);
  await startFrames(page, true);
  fixture.prepend();
  await expect(page.getByRole('button', { name: '加载中', exact: true })).toHaveCount(0);
  await stopFrames(page, testInfo);
  // The old page had spare space below its messages. Once older records fill that space,
  // its previous pixel offset can be unreachable; keep reading history instead of tail-following.
  expect(await fromEnd(page)).toBeGreaterThan(40);
  expect(await box.locator('.message.user').count()).toBe(turns);
  await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
});

test('reading history again after returning to live output preserves the latest position while loading', async ({
  page,
}, testInfo) => {
  const fixture = await open(page, false, 'history');
  const box = page.locator('.conversation');
  await box.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(fixture.earlierRequests).toBe(1);
  await page.getByRole('button', { name: '回到底部', exact: true }).click();
  expect(await fromEnd(page)).toBeLessThan(2);
  await box.hover();
  await page.mouse.wheel(0, -1500);
  expect(await fromEnd(page)).toBeGreaterThan(500);
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.conversation')!;
    const area = root.getBoundingClientRect();
    const underPointer = document.elementFromPoint(
      area.left + area.width / 2,
      area.top + area.height / 2,
    );
    const anchor =
      underPointer?.closest<HTMLElement>('[data-message-id]') ??
      [...root.querySelectorAll<HTMLElement>('[data-message-id]')].find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top >= area.top && rect.bottom <= area.bottom;
      });
    if (!anchor || !root.contains(anchor)) throw new Error('No visible reading message');
    anchor.dataset.followAnchor = 'true';
  });
  await startFrames(page, true);
  fixture.prepend();
  await expect(page.getByRole('button', { name: '加载中', exact: true })).toHaveCount(0);
  expectStableAnchor(await stopFrames(page, testInfo));
  await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
  expect(fixture.earlierRequests()).toBe(1);
});
