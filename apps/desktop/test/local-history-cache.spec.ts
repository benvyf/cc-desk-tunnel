import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  PROTOCOL_VERSION,
  type Command,
  type Session,
  type SessionEvent,
} from '@cc-desk-tunnel/protocol';

async function fixture(turns = 40) {
  const profile = await mkdtemp(resolve('.local/history-cache-ui-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', r));
  const address = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
  const connectionId = randomUUID(),
    now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '本机记录验收',
    autoTitle: false,
    projectPath: profile,
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const events: SessionEvent[] = [];
  for (let n = 0; n < turns; n++) {
    const runId = randomUUID(),
      messageId = randomUUID();
    for (const payload of [
      {
        type: 'message.user' as const,
        messageId,
        text: `缓存问题 ${n}`,
        scenario: 'chat' as const,
      },
      {
        type: 'text.delta' as const,
        messageId: randomUUID(),
        text: `缓存回答 ${n}。\n\n` + '这里是用于本机缓存验收的历史内容。'.repeat(15),
      },
      { type: 'run.status' as const, status: 'completed' as const, connectionId },
    ])
      events.push({
        sessionId: session.id,
        sequence: events.length + 1,
        runId,
        createdAt: now,
        payload,
      });
  }
  let delay = 0,
    replace = false,
    hold = false,
    refuse = false;
  let adapter: 'simulation' | 'claude-code' = 'simulation';
  const held: (() => void)[] = [];
  const commands: Command[] = [];
  const requests: { afterSequence: number }[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let finishTerminal = () => {};
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      const send = (value: unknown) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(value));
      };
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.10',
          connectionId,
          adapter,
          sessions: [session],
        });
        return;
      }
      if (command.type === 'device' || command.type === 'leave') return;
      if (command.type === 'terminal.open') {
        const terminalId = randomUUID();
        send({ type: 'terminal.opened', sessionId: command.sessionId, terminalId });
        finishTerminal = () =>
          send({ type: 'terminal.closed', sessionId: command.sessionId, terminalId, exitCode: 0 });
      }
      if (command.type === 'session.subscribe') {
        requests.push(command);
        const respond = () => {
          if (refuse) {
            send({
              type: 'response',
              requestId: command.requestId,
              ok: false,
              code: 'session_busy',
              message: '验收：历史同步暂时失败',
            });
            return;
          }
          const append = command.afterSequence > 0 && !replace;
          const list = append ? events.filter((e) => e.sequence > command.afterSequence) : events;
          send({
            type: 'session.snapshot',
            requestId: command.requestId,
            session,
            mode: append ? 'append' : 'replace',
            firstSequence: list[0]?.sequence ?? 0,
            lastSequence: events.at(-1)?.sequence ?? 0,
            hasEarlier: false,
            events: list,
          });
          send({ type: 'response', requestId: command.requestId, ok: true });
        };
        if (hold) held.push(respond);
        else if (delay) timers.push(setTimeout(respond, delay));
        else respond();
        return;
      }
      send({ type: 'response', requestId: command.requestId, ok: true });
    }),
  );
  let app: ElectronApplication;
  async function launch(select = true) {
    app = await _electron.launch({
      args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
        ),
      ) as Record<string, string>,
    });
    const page = await app.firstWindow();
    await page.evaluate(
      async ({ address }) => {
        await window.desktop!.saveLogin({
          authMethod: 'manual',
          mode: 'local',
          url: address,
          token: 'test-token-with-enough-characters',
          fingerprint: '',
          remember: true,
          autoLogin: false,
        });
      },
      { address },
    );
    await page.reload();
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
    if (await expand.isVisible()) await expand.click();
    if (select)
      await page
        .locator('.session-row')
        .filter({ hasText: session.title })
        .locator('.session-select')
        .click();
    return page;
  }
  async function copies(): Promise<string[]> {
    try {
      const root = join(profile, 'history-cache');
      const owners = await readdir(root);
      return (
        await Promise.all(
          owners.map(async (owner) =>
            (await readdir(join(root, owner)))
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => join(root, owner, f)),
          ),
        )
      ).flat();
    } catch {
      return [];
    }
  }
  return {
    profile,
    requests,
    commands,
    finishTerminal: () => finishTerminal(),
    events,
    session,
    launch,
    copies,
    delay: () => {
      delay = 3000;
    },
    refuse: (value = true) => {
      refuse = value;
    },
    native: () => {
      adapter = 'claude-code';
    },
    startRun: () => {
      session.activeRun = { id: randomUUID(), status: 'running', connectionId };
      return session.activeRun.id;
    },
    replace: () => {
      replace = true;
    },
    hold: () => {
      hold = true;
    },
    release: () => {
      held.splice(0).forEach((respond) => respond());
    },
    emit: (event: SessionEvent) => {
      events.push(event);
      for (const socket of server.clients)
        socket.send(JSON.stringify({ type: 'session.event', event }));
    },
    close: async () => {
      await app?.close();
    },
    cleanup: async () => {
      timers.forEach(clearTimeout);
      // Final fixture cleanup is not a quit-flow test; close synthetic terminal windows
      // without letting an incomplete mock terminal lifecycle mask an assertion failure.
      await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app?.close().catch(() => {});
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
async function general(page: Page) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '常规', exact: true })
    .click();
}
test('real Electron restart shows disk history during a 3s subscription delay and appends at the bottom', async () => {
  test.setTimeout(60000);
  const f = await fixture();
  try {
    let page = await f.launch();
    await expect(page.getByText('缓存问题 39', { exact: true })).toBeVisible();
    await expect.poll(async () => (await f.copies()).length).toBe(1);
    await f.close();
    f.delay();
    f.events.push({
      ...f.events.at(-1)!,
      sequence: 121,
      runId: randomUUID(),
      payload: { type: 'text.delta', messageId: randomUUID(), text: '补拉的新内容' },
    });
    page = await f.launch();
    await expect(page.getByText('缓存问题 39', { exact: true })).toBeVisible({ timeout: 1500 });
    await expect(page.getByText('同步会话', { exact: true })).toBeVisible();
    expect(f.requests.at(-1)?.afterSequence).toBe(120);
    await expect(page.getByText('补拉的新内容', { exact: true })).toBeVisible();
    await expect(page.getByText('同步会话', { exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .locator('.conversation')
          .evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight),
      )
      .toBeLessThan(40);
    const log = await readFile(join(f.profile, 'logs', 'client.log'), 'utf8');
    expect(log).toContain('selectToStateMs=');
  } finally {
    await f.cleanup();
  }
});

test('2000-event real IPC hydration records select-to-state within 50 ms', async ({}, testInfo) => {
  test.setTimeout(90000);
  const f = await fixture(666);
  f.events.push(
    { ...f.events[0], sequence: 1999, runId: randomUUID() },
    { ...f.events[1], sequence: 2000, runId: randomUUID() },
  );
  // Keep this full 2000-event fixture below the 1 MB byte cap.
  for (const event of f.events)
    if (event.payload.type === 'text.delta') event.payload.text = '2000 条事件注水验收';
  try {
    await f.launch();
    await expect.poll(async () => (await f.copies()).length).toBe(1);
    await f.close();
    f.hold();
    await f.launch();
    const file = join(f.profile, 'logs', 'client.log');
    await expect
      .poll(async () => {
        try {
          return await readFile(file, 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('events=2000');
    const log = await readFile(file, 'utf8');
    const ms = Number(log.match(/events=2000 selectToStateMs=([\d.]+)/)?.[1]);
    await testInfo.attach('real-ipc-hydration', {
      body: JSON.stringify({ events: 2000, selectToStateMs: ms, log }, null, 2),
      contentType: 'application/json',
    });
    expect(ms).toBeLessThanOrEqual(50);
  } finally {
    await f.cleanup();
  }
});
test('reading position survives authoritative replace after scrolling up during cached synchronization', async () => {
  test.setTimeout(60000);
  const f = await fixture();
  try {
    let page = await f.launch();
    await expect.poll(async () => (await f.copies()).length).toBe(1);
    await f.close();
    f.hold();
    f.replace();
    page = await f.launch();
    await expect(page.getByText('同步会话', { exact: true })).toBeVisible();
    const box = page.locator('.conversation');
    // Hidden Electron smoke windows do not receive OS wheel input. Exercise the same DOM
    // wheel/scroll handlers while moving its actual scroll container.
    await box.evaluate((box) => {
      box.dispatchEvent(new WheelEvent('wheel', { deltaY: -1800, bubbles: true }));
      box.scrollTop -= 1800;
    });
    await page.waitForTimeout(250);
    const top = await box.evaluate((box) => box.scrollTop);
    await expect(page.getByText('同步会话', { exact: true })).toHaveCount(1);
    expect(
      await box.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight),
    ).toBeGreaterThan(100);
    f.release();
    await expect(page.getByText('同步会话', { exact: true })).toHaveCount(0);
    expect(Math.abs((await box.evaluate((box) => box.scrollTop)) - top)).toBeLessThan(40);
  } finally {
    await f.cleanup();
  }
});
test('disabling local history clears real files and uses the original network-only loading path', async () => {
  test.setTimeout(60000);
  const f = await fixture();
  try {
    let page = await f.launch();
    await expect.poll(async () => (await f.copies()).length).toBe(1);
    await general(page);
    await page.getByRole('switch', { name: '在本机保存聊天记录', exact: true }).click();
    await expect.poll(async () => (await f.copies()).length).toBe(0);
    await f.close();
    f.delay();
    page = await f.launch();
    await expect(page.getByText('同步会话', { exact: true })).toBeVisible();
    await expect(page.getByText('缓存问题 39', { exact: true })).toHaveCount(0);
    expect(f.requests.at(-1)?.afterSequence).toBe(0);
    await expect(page.getByText('缓存问题 39', { exact: true })).toBeVisible();
    expect(await f.copies()).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test('double clearing real disk copies keeps caching enabled for the next proven stream', async () => {
  test.setTimeout(60000);
  const f = await fixture();
  try {
    const page = await f.launch();
    await expect.poll(async () => (await f.copies()).length).toBe(1);
    await general(page);
    await page.getByRole('button', { name: /清除本机记录（占用/ }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect.poll(async () => (await f.copies()).length).toBe(0);
    await expect(
      page.getByRole('switch', { name: '在本机保存聊天记录', exact: true }),
    ).toBeChecked();
    f.emit({
      ...f.events.at(-1)!,
      sequence: 121,
      runId: randomUUID(),
      payload: { type: 'text.delta', messageId: randomUUID(), text: '清除后继续记录' },
    });
    await expect.poll(async () => (await f.copies()).length).toBe(1);
    const copy = await readFile((await f.copies())[0], 'utf8');
    expect(copy).toContain('清除后继续记录');
  } finally {
    await f.cleanup();
  }
});

test('re-enabling caching immediately revalidates and records the already open conversation', async () => {
  test.setTimeout(60000);
  const f = await fixture();
  try {
    const page = await f.launch();
    await expect.poll(async () => (await f.copies()).length).toBe(1);
    await general(page);
    const toggle = page.getByRole('switch', { name: '在本机保存聊天记录', exact: true });
    await toggle.click();
    await expect.poll(async () => (await f.copies()).length).toBe(0);
    const requests = f.requests.length;
    await toggle.click();
    await expect.poll(() => f.requests.length).toBeGreaterThan(requests);
    await expect.poll(async () => (await f.copies()).length).toBe(1);
  } finally {
    await f.cleanup();
  }
});
test('failed cached synchronization restores input and reselecting the same session recovers', async () => {
  test.setTimeout(60000);
  const f = await fixture();
  try {
    let page = await f.launch();
    await expect.poll(async () => (await f.copies()).length).toBe(1);
    await f.close();
    f.refuse();
    page = await f.launch();
    await expect(page.getByText('验收：历史同步暂时失败', { exact: true })).toBeVisible();
    await expect(page.getByText('缓存问题 39', { exact: true })).toBeVisible();
    await expect(page.getByText('同步会话', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('消息', { exact: true })).toBeEnabled();
    const requests = f.requests.length;
    f.refuse(false);
    f.events.push({
      ...f.events.at(-1)!,
      sequence: 121,
      runId: randomUUID(),
      payload: { type: 'text.delta', messageId: randomUUID(), text: '重选后恢复同步' },
    });
    await page
      .locator('.session-row')
      .filter({ hasText: f.session.title })
      .locator('.session-select')
      .click();
    await expect.poll(() => f.requests.length).toBeGreaterThan(requests);
    await expect(page.getByText('重选后恢复同步', { exact: true })).toBeVisible();
    await expect(page.getByText('同步会话', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('消息', { exact: true })).toBeEnabled();
  } finally {
    await f.cleanup();
  }
});

for (const trigger of ['stop button', 'double Escape'] as const) {
  test(`real Electron ${trigger} cancels the ready active run while cached history is pending`, async () => {
    test.setTimeout(60000);
    const f = await fixture();
    try {
      let page = await f.launch();
      await expect.poll(async () => (await f.copies()).length).toBe(1);
      await f.close();
      f.native();
      const runId = f.startRun();
      f.hold();
      page = await f.launch();
      await expect(page.getByText('缓存问题 39', { exact: true })).toBeVisible();
      await expect(page.getByText('同步会话', { exact: true })).toBeVisible();
      await expect(page.getByLabel('消息', { exact: true })).toBeDisabled();
      const stop = page.getByRole('button', { name: '停止运行', exact: true });
      await expect(stop).toBeEnabled();
      const cancellations = () => f.commands.filter((command) => command.type === 'run.cancel');
      expect(cancellations()).toHaveLength(0);
      if (trigger === 'stop button') await stop.click();
      else {
        // The pending composer is disabled, so focus the conversation's existing keyboard target.
        const conversation = page.locator('.conversation');
        await conversation.focus();
        await expect(conversation).toBeFocused();
        await conversation.press('Escape');
        expect(cancellations()).toHaveLength(0);
        await conversation.press('Escape');
      }
      await expect.poll(() => cancellations().length).toBe(1);
      expect(cancellations()[0]).toMatchObject({
        type: 'run.cancel',
        sessionId: f.session.id,
        runId,
      });
      // No snapshot has been released: cancellation must not wait for history synchronization.
      await expect(page.getByText('同步会话', { exact: true })).toBeVisible();
      expect(f.commands.filter((command) => command.type === 'message.send')).toHaveLength(0);
      expect(f.commands.filter((command) => command.type === 'terminal.open')).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });
}

test('real Electron native terminal entry is disabled while a cached snapshot is held', async () => {
  test.setTimeout(60000);
  const f = await fixture();
  try {
    let page = await f.launch();
    await expect.poll(async () => (await f.copies()).length).toBe(1);
    await f.close();
    f.native();
    f.hold();
    page = await f.launch();
    await expect(page.getByText('缓存问题 39', { exact: true })).toBeVisible();
    await expect(page.getByText('同步会话', { exact: true })).toBeVisible();
    const terminal = page.getByRole('button', { name: '终端', exact: true });
    await expect(terminal).toBeVisible();
    await expect(terminal).toBeDisabled();
    expect(f.commands.filter((command) => command.type === 'terminal.open')).toHaveLength(0);
    expect(f.commands.filter((command) => command.type === 'message.send')).toHaveLength(0);
    f.release();
    await expect(page.getByText('同步会话', { exact: true })).toHaveCount(0);
    await expect(terminal).toBeEnabled();
    expect(f.commands.filter((command) => command.type === 'terminal.open')).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test('opening a never-selected session terminal does not silently lose the initial click', async () => {
  test.setTimeout(60000);
  const f = await fixture();
  try {
    f.native();
    const page = await f.launch(false);
    const row = page.locator('.session-row').filter({ hasText: f.session.title });
    await row.hover();
    await row.getByRole('button', { name: '会话操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '原生终端', exact: true }).click();
    await expect
      .poll(() => f.commands.filter((command) => command.type === 'terminal.open').length)
      .toBe(1);
    f.finishTerminal();
  } finally {
    await f.cleanup();
  }
});
