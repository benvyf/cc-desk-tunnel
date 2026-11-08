import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import {
  PROTOCOL_VERSION,
  type Session,
  type SessionEvent,
  type EventPayload,
} from '@cc-desk-tunnel/protocol';
import {
  installPerformanceProbe,
  percentile,
  readPerformanceProbe,
  resetPerformanceProbe,
} from './fixtures/conversation-performance.ts';

const address = 'ws://127.0.0.1:18913/ws';
const answer = '主侧性能基线。\n\n[静态文档](D:/performance/baseline.txt)';

async function fixture(page: Page) {
  await installPerformanceProbe(page);
  // Only this fake desktop bridge is installed; no Electron IPC, filesystem, server or model is used.
  await page.addInitScript(() => {
    const noop = async () => {};
    const listener = () => () => {};
    const counts = ((window as any).performanceDesktop = {
      reads: 0,
      watches: 0,
      unwatches: 0,
      changedAdds: 0,
      changedRemoves: 0,
    });
    (window as any).desktop = {
      dev: true,
      platform: 'win32',
      version: async () => '0.0.1',
      boot: { connection: '', shared: { connections: [], busy: [] } },
      device: async () => ({ id: 'performance-device', name: 'Performance fixture' }),
      loadLogin: async () => null,
      saveLogin: noop,
      disconnectProxy: noop,
      connectProxy: async () => ({ url: 'ws://127.0.0.1:18913/ws' }),
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
        pick: async () => 'D:/performance/baseline.txt',
        read: async ({ path }: { path: string }) => {
          counts.reads++;
          return { path, kind: 'text', text: 'Static baseline document\n'.repeat(500) };
        },
        watch: async () => {
          counts.watches++;
        },
        unwatch: async () => {
          counts.unwatches++;
        },
        onChanged: () => {
          counts.changedAdds++;
          return () => {
            counts.changedRemoves++;
          };
        },
        onState: listener,
        releaseFile: noop,
        release: noop,
        bounds: noop,
        hide: noop,
      },
    };
  });
  const now = new Date().toISOString(),
    connectionId = randomUUID();
  const main: Session = {
    id: randomUUID(),
    title: '并行性能主会话',
    autoTitle: false,
    projectPath: 'D:/performance',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const sessions = [main],
    events = new Map<string, SessionEvent[]>([[main.id, []]]);
  const calls: { type: string; sessionId?: string }[] = [];
  let send = (_value: unknown) => {};
  function add(sessionId: string, runId: string, payload: EventPayload) {
    const list = events.get(sessionId)!;
    const event: SessionEvent = {
      sessionId,
      runId,
      sequence: list.length + 1,
      createdAt: new Date().toISOString(),
      payload,
    };
    list.push(event);
    return event;
  }
  const initialRun = randomUUID();
  add(main.id, initialRun, {
    type: 'message.user',
    messageId: randomUUID(),
    text: '并行输出基线',
    scenario: 'chat',
  });
  add(main.id, initialRun, { type: 'text.delta', messageId: randomUUID(), text: answer });
  add(main.id, initialRun, { type: 'run.status', status: 'completed', connectionId });
  await page.routeWebSocket(address, (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      calls.push(message);
      if (message.type === 'device') return;
      const respond = (sessionId = message.sessionId) =>
        send({ type: 'response', requestId: message.requestId, ok: true, sessionId });
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sideConversations: true,
          sessions,
        });
        return;
      }
      if (message.type === 'session.subscribe') {
        const session = sessions.find((item) => item.id === message.sessionId)!;
        const list = events.get(session.id)!;
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: list[0]?.sequence ?? 0,
          lastSequence: list.at(-1)?.sequence ?? 0,
          hasEarlier: false,
          events: list,
        });
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
        events.set(child.id, []);
        send({ type: 'session.updated', session: child });
        respond(child.id);
        return;
      }
      respond();
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill(address);
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('performance-fixture-token-with-enough-characters');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page
    .locator('.session-row')
    .filter({ hasText: main.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.workspace .message.assistant')).toContainText('主侧性能基线');
  await page
    .locator('.workspace')
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .last()
    .click();
  await expect(page.getByRole('region', { name: '侧边会话', exact: true })).toBeVisible();
  await expect
    .poll(
      () =>
        new Set(
          calls.filter((call) => call.type === 'session.subscribe').map((call) => call.sessionId),
        ).size,
    )
    .toBe(2);
  return {
    main,
    calls,
    longOutput(kind: 'text.delta' | 'thinking.delta', fragments: number) {
      const bytes = 256 * 1024;
      const text =
        kind === 'thinking.delta'
          ? '\n'.repeat(bytes / 2) + 'thinking 01234567\n'.repeat(bytes / 8).slice(0, bytes / 2)
          : 'answer 01234567\n'.repeat(bytes / 8).slice(0, bytes);
      const runId = randomUUID(),
        messageId = randomUUID();
      main.activeRun = { id: runId, connectionId, status: 'running' };
      send({ type: 'session.updated', session: main });
      send({
        type: 'session.event',
        event: add(main.id, runId, {
          type: 'message.user',
          messageId: randomUUID(),
          text: '256 KiB 浏览器绘制基线',
          scenario: 'chat',
        }),
      });
      send({
        type: 'session.event',
        event: add(main.id, runId, { type: 'run.status', status: 'running', connectionId }),
      });
      const fragment = (n: number) =>
        send({
          type: 'session.fragment',
          sessionId: main.id,
          runId,
          payload: {
            type: kind,
            messageId,
            text: text.slice((n * bytes) / fragments, ((n + 1) * bytes) / fragments),
          },
        });
      fragment(0); // Mount/open the actual output view before measuring the remaining paced delivery.
      return {
        text,
        messageId,
        async deliver() {
          const began = performance.now();
          let sent = 1;
          for (let batch = 1; batch <= 100; batch++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            const through = Math.ceil((batch * fragments) / 100);
            while (sent < through) fragment(sent++);
          }
          return { pacedDeliveryMs: performance.now() - began, batches: 100, fragmentsSent: sent };
        },
        finish() {
          send({
            type: 'session.event',
            event: add(main.id, runId, { type: kind, messageId, text }),
          });
          send({
            type: 'session.event',
            event: add(main.id, runId, { type: 'run.status', status: 'completed', connectionId }),
          });
          main.activeRun = null;
          send({ type: 'session.updated', session: main });
        },
      };
    },
    start() {
      const runs = sessions.map((session) => ({
        session,
        runId: randomUUID(),
        messageId: randomUUID(),
        text: '',
      }));
      for (const run of runs) {
        run.session.activeRun = { id: run.runId, connectionId, status: 'running' };
        send({ type: 'session.updated', session: run.session });
        send({
          type: 'session.event',
          event: add(run.session.id, run.runId, {
            type: 'message.user',
            messageId: randomUUID(),
            text: '持续输出30秒',
            scenario: 'chat',
          }),
        });
        send({
          type: 'session.event',
          event: add(run.session.id, run.runId, {
            type: 'run.status',
            status: 'running',
            connectionId,
          }),
        });
      }
      let ticks = 0;
      const started = performance.now();
      const timer = setInterval(() => {
        ticks++;
        for (const run of runs) {
          const text = `输出${ticks}：保持主侧会话各自独立。 `;
          run.text += text;
          send({
            type: 'session.fragment',
            sessionId: run.session.id,
            runId: run.runId,
            payload: { type: 'text.delta', messageId: run.messageId, text },
          });
        }
      }, 50);
      return () => {
        clearInterval(timer);
        for (const run of runs) {
          send({
            type: 'session.event',
            event: add(run.session.id, run.runId, {
              type: 'text.delta',
              messageId: run.messageId,
              text: run.text,
            }),
          });
          send({
            type: 'session.event',
            event: add(run.session.id, run.runId, {
              type: 'run.status',
              status: 'completed',
              connectionId,
            }),
          });
          run.session.activeRun = null;
          send({ type: 'session.updated', session: run.session });
        }
        return {
          durationMs: performance.now() - started,
          ticks,
          text: runs.map((run) => run.text),
        };
      };
    },
  };
}

for (const fragments of [4096, 16384]) {
  for (const kind of ['text.delta', 'thinking.delta'] as const) {
    test(`256 KiB browser output in ${fragments} paced fragments · ${kind}`, async ({
      page,
      browser,
    }, testInfo) => {
      test.setTimeout(60_000);
      const f = await fixture(page);
      // Read raw whitespace and release state through a test-only wrapper of the real public view method.
      // The wrapper retains references only; no additional assembly or string copying enters delivery timing.
      await page.evaluate(async (sessionId) => {
        const path = '/src/client.ts';
        const { ProxyClient } = await import(path);
        const shown = ProxyClient.prototype.shown;
        ProxyClient.prototype.shown = function (id: string) {
          const events = shown.call(this, id);
          if (id === sessionId)
            (window as any).longOutputSnapshot = {
              events,
              live: this.getSnapshot().live[id] ?? null,
            };
          return events;
        };
      }, f.main.id);
      const output = f.longOutput(kind, fragments);
      expect(Buffer.byteLength(output.text)).toBe(256 * 1024);
      if (kind === 'thinking.delta') {
        await page.locator('.workspace .work > summary').last().click();
        await page.locator('.workspace .thinking-block > summary').last().click();
      }
      const cdp =
        process.env.HARNESS_CPU_PROFILE === '1' ||
        (process.env.HARNESS_CPU_PROFILE === 'first' && kind === 'text.delta' && fragments === 4096)
          ? await page.context().newCDPSession(page)
          : undefined;
      let beforeMetrics: { name: string; value: number }[] = [];
      const phases: { name: string; browserMs: number }[] = [];
      if (cdp) {
        await cdp.send('Performance.enable');
        beforeMetrics = (await cdp.send('Performance.getMetrics')).metrics;
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      }
      await resetPerformanceProbe(page);
      const began = await page.evaluate(() => performance.now());
      if (cdp) phases.push({ name: 'begin', browserMs: began });
      const delivery = await output.deliver();
      if (cdp)
        phases.push({
          name: 'delivery-sent',
          browserMs: await page.evaluate(() => performance.now()),
        });
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const live = (window as any).longOutputSnapshot?.live;
            return live?.payload.messageId === id ? live.payload.text.length : 0;
          }, output.messageId),
        )
        .toBe(256 * 1024);
      const bodyMatches = () =>
        page.evaluate(
          ({ kind, messageId, text }) => {
            if (kind === 'text.delta')
              return (
                document
                  .querySelector(`[data-message-id="${messageId}"] [data-copy-text]`)
                  ?.getAttribute('data-copy-text') === text
              );
            return (
              document.querySelector('.workspace .thinking-content')?.textContent?.trim() ===
              text.trim()
            );
          },
          { kind, messageId: output.messageId, text: output.text },
        );
      await expect.poll(bodyMatches).toBe(true);
      const liveMatches = await page.evaluate(
        ({ messageId, text }) => {
          const live = (window as any).longOutputSnapshot.live;
          return live.payload.messageId === messageId && live.payload.text === text;
        },
        { messageId: output.messageId, text: output.text },
      );
      expect(liveMatches).toBe(true);
      if (cdp)
        phases.push({
          name: 'live-body-verified',
          browserMs: await page.evaluate(() => performance.now()),
        });
      output.finish();
      await expect
        .poll(() => page.evaluate(() => (window as any).longOutputSnapshot.live))
        .toBeNull();
      const recordedMatches = await page.evaluate(
        ({ messageId, text }) => {
          const recorded = (window as any).longOutputSnapshot.events.filter(
            (event: SessionEvent) =>
              (event.payload.type === 'text.delta' || event.payload.type === 'thinking.delta') &&
              event.payload.messageId === messageId,
          );
          return recorded.length === 1 && recorded[0].payload.text === text;
        },
        { messageId: output.messageId, text: output.text },
      );
      expect(recordedMatches).toBe(true);
      if (kind === 'thinking.delta') {
        await page.locator('.workspace .turn-process > summary').last().click();
        await page.locator('.workspace .work > summary').last().click();
        await page.locator('.workspace .thinking-block > summary').last().click();
      }
      await expect.poll(bodyMatches).toBe(true);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const browserSettledMs = await page.evaluate((start) => performance.now() - start, began);
      const metrics = await readPerformanceProbe(page);
      let profiling: unknown;
      if (cdp) {
        phases.push({ name: 'recorded-body-settled', browserMs: began + browserSettledMs });
        const { profile } = await cdp.send('Profiler.stop');
        const after = (await cdp.send('Performance.getMetrics')).metrics;
        const dom = await page.evaluate((messageId) => {
          const root =
            document.querySelector(`[data-message-id="${messageId}"] [data-copy-text]`) ??
            document.querySelector('.workspace .thinking-content');
          if (!root) throw new Error('Measured output body is missing');
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let textNodes = 0,
            maxTextNodeChars = 0,
            node: Node | null;
          while ((node = walker.nextNode())) {
            textNodes++;
            maxTextNodeChars = Math.max(maxTextNodeChars, node.textContent?.length ?? 0);
          }
          return {
            elements: root.querySelectorAll('*').length,
            paragraphs: root.querySelectorAll('p').length,
            textNodes,
            maxTextNodeChars,
            scrollHeight: root.scrollHeight,
          };
        }, output.messageId);
        profiling = {
          phases,
          dom,
          metricDeltas: Object.fromEntries(
            after.map(({ name, value }) => [
              name,
              value - (beforeMetrics.find((metric) => metric.name === name)?.value ?? 0),
            ]),
          ),
        };
        const profilePath = testInfo.outputPath('browser.cpuprofile');
        await writeFile(profilePath, JSON.stringify(profile));
        await testInfo.attach('browser.cpuprofile', {
          path: profilePath,
          contentType: 'application/json',
        });
        await writeFile(testInfo.outputPath('profiling.json'), JSON.stringify(profiling, null, 2));
        await cdp.detach();
      }
      const measurement = {
        workload: '256KiB-browser',
        kind,
        fragments,
        bytes: Buffer.byteLength(output.text),
        ...delivery,
        browserSettledMs,
        ...metrics,
        exactLive: liveMatches,
        exactRecorded: recordedMatches,
        liveReleased: true,
        profiling,
        browser: browser.version(),
        node: process.version,
        viewport: page.viewportSize(),
        repeat: testInfo.repeatEachIndex,
      };
      console.log(JSON.stringify(measurement));
      await testInfo.attach('performance.json', {
        body: JSON.stringify(measurement, null, 2),
        contentType: 'application/json',
      });
      expect(delivery.fragmentsSent).toBe(fragments);
      expect(delivery.pacedDeliveryMs).toBeGreaterThanOrEqual(2000);
    });
  }
}

for (const staticPreview of [false, true]) {
  test(`30 seconds of parallel main/side output with 120 typed characters · static preview ${staticPreview ? 'open' : 'closed'}`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const f = await fixture(page);
    if (staticPreview) {
      await page.locator('.workspace').getByRole('link', { name: '静态文档', exact: true }).click();
      await expect(page.locator('.preview-document')).toContainText('Static baseline document');
      await page.getByRole('button', { name: '分栏预览', exact: true }).click();
      await expect(page.getByRole('region', { name: '侧边会话', exact: true })).toBeVisible();
    }
    const main = page.locator('.workspace').getByRole('textbox', { name: '消息', exact: true });
    const side = page
      .getByRole('region', { name: '侧边会话', exact: true })
      .getByRole('textbox', { name: '消息', exact: true });
    await main.evaluate((el) => {
      (el as HTMLElement).dataset.performanceInput = 'main';
    });
    await side.evaluate((el) => {
      (el as HTMLElement).dataset.performanceInput = 'side';
    });
    // Leave a draft in the unfocused composer so a misplaced keystroke cannot go unnoticed.
    await main.fill('main:');
    await side.fill('side:');
    await page.waitForTimeout(250);
    await resetPerformanceProbe(page);
    const desktopBefore = await page.evaluate(() => ({ ...(window as any).performanceDesktop }));
    const subscriptions = f.calls.filter((call) => call.type === 'session.subscribe').length;
    const stop = f.start();
    const typed = 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwx'; // 60 ASCII characters
    let stream: ReturnType<typeof stop>;
    const operationMs: number[] = [];
    try {
      for (const box of [main, side]) {
        const began = performance.now();
        await box.pressSequentially(typed, { delay: 250 });
        operationMs.push(performance.now() - began);
      }
    } finally {
      stream = stop();
    }
    await expect(main).toHaveValue('main:' + typed);
    await expect(side).toHaveValue('side:' + typed);
    await expect(
      page.locator('.workspace .message.assistant [data-copy-text]').last(),
    ).toHaveAttribute('data-copy-text', stream.text[0]);
    await expect(
      page
        .getByRole('region', { name: '侧边会话', exact: true })
        .locator('.message.assistant [data-copy-text]')
        .last(),
    ).toHaveAttribute('data-copy-text', stream.text[1]);
    const metrics = await readPerformanceProbe(page);
    const frameSamples = [
      ...(metrics.inputFrameMs.main ?? []),
      ...(metrics.inputFrameMs.side ?? []),
    ];
    const desktop = await page.evaluate(() => (window as any).performanceDesktop);
    const measurement = {
      workload: 'parallel-30s',
      staticPreview,
      ...stream,
      text: undefined,
      inputFrameP50Ms: percentile(frameSamples, 0.5),
      inputFrameP95Ms: percentile(frameSamples, 0.95),
      keyDelayMs: 250,
      playwrightPacedMsPerKey: operationMs.map((ms) => ms / typed.length),
      ...metrics,
      desktop,
      fileReadsDuringStream: desktop.reads - desktopBefore.reads,
      subscriptionRequestsDuringStream:
        f.calls.filter((call) => call.type === 'session.subscribe').length - subscriptions,
      browser: browser.version(),
      node: process.version,
      viewport: page.viewportSize(),
      repeat: testInfo.repeatEachIndex,
    };
    console.log(JSON.stringify(measurement));
    await testInfo.attach('performance.json', {
      body: JSON.stringify(measurement, null, 2),
      contentType: 'application/json',
    });
    expect(typed).toHaveLength(60);
    expect(stream.durationMs).toBeGreaterThanOrEqual(30_000);
    expect(metrics.inputFrameMs.main).toHaveLength(60);
    expect(metrics.inputFrameMs.side).toHaveLength(60);
    expect(percentile(frameSamples, 0.95)).toBeLessThanOrEqual(100);
    expect(measurement.subscriptionRequestsDuringStream).toBe(0);
    expect(measurement.fileReadsDuringStream).toBe(0);
    if (staticPreview) expect(desktop.reads).toBeGreaterThan(0);
  });
}
