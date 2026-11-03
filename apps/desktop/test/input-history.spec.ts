import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session, type SessionEvent } from '@cc-desk-tunnel/protocol';

async function fixture(page: Page, seedHistory = false) {
  const connectionId = randomUUID();
  const now = new Date().toISOString();
  const sessions: Session[] = ['first', 'same project', 'other project'].map((title, index) => ({
    id: randomUUID(),
    title,
    projectPath: index === 2 ? '/other' : '/project',
    autoTitle: false,
    permissionMode: 'default',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  }));
  const events = new Map(sessions.map((session) => [session.id, [] as SessionEvent[]]));
  if (seedHistory)
    events.get(sessions[0].id)!.push({
      sessionId: sessions[0].id,
      runId: randomUUID(),
      sequence: 1,
      createdAt: now,
      payload: {
        type: 'message.user',
        messageId: randomUUID(),
        text: 'existing command',
        scenario: 'chat',
      },
    });
  const requests: { text: string; sessionId: string }[] = [];
  let failNext = false;
  let holdNext = false;
  let finishSend = () => {};
  let send = (_message: object) => {};
  await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
    send = (message) => route.send(JSON.stringify(message));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          adapter: 'claude-code',
          connectionId,
          sessions,
        });
      const session = sessions.find((item) => item.id === message.sessionId);
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          events: events.get(session!.id),
          mode: 'replace',
          firstSequence: 1,
          lastSequence: events.get(session!.id)!.length,
          hasEarlier: false,
        });
      if (message.type === 'message.send') {
        if (failNext) {
          failNext = false;
          return send({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            message: 'test send failure',
          });
        }
        requests.push({ text: message.text, sessionId: session!.id });
        const list = events.get(session!.id)!;
        const event: SessionEvent = {
          sessionId: session!.id,
          runId: randomUUID(),
          sequence: list.length + 1,
          createdAt: now,
          payload: {
            type: 'message.user',
            messageId: message.requestId,
            text: message.text,
            scenario: 'chat',
          },
        };
        list.push(event);
        send({ type: 'session.event', event });
        if (holdNext) {
          holdNext = false;
          finishSend = () => send({ type: 'response', requestId: message.requestId, ok: true });
          return;
        }
      }
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  const connect = async () => {
    await page.goto('/');
    await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18894/ws');
    await page
      .getByLabel('服务凭据', { exact: true })
      .fill('test-input-history-not-real-credential');
    await page.getByRole('button', { name: '连接', exact: true }).click();
  };
  const select = async (index: number, waitForInput = true) => {
    await page
      .locator('.session-row')
      .filter({ hasText: sessions[index].title })
      .locator('.session-select')
      .click();
    if (waitForInput)
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  };
  await connect();
  await select(0);
  return {
    sessions,
    requests,
    select,
    connect,
    fail: () => {
      failNext = true;
    },
    hold: () => {
      holdNext = true;
    },
    finishSend: () => finishSend(),
    run: () => {
      sessions[0].activeRun = { id: randomUUID(), status: 'running', connectionId };
      send({ type: 'session.updated', session: sessions[0] });
    },
    continuation: () => {
      const list = events.get(sessions[0].id)!;
      const event: SessionEvent = {
        sessionId: sessions[0].id,
        runId: randomUUID(),
        sequence: list.length + 1,
        createdAt: now,
        payload: {
          type: 'message.user',
          messageId: randomUUID(),
          text: 'internal continuation template',
          continued: true,
          scenario: 'chat',
        },
      };
      list.push(event);
      send({ type: 'session.event', event });
      const output: SessionEvent = {
        ...event,
        sequence: list.length + 1,
        payload: {
          type: 'text.delta',
          messageId: randomUUID(),
          text: 'continuation output received',
        },
      };
      list.push(output);
      send({ type: 'session.event', event: output });
    },
  };
}
const box = (page: Page) => page.getByRole('textbox', { name: '消息', exact: true });
async function submit(page: Page, text: string, queued = false) {
  await box(page).fill(text);
  await box(page).press('Enter');
  await expect(box(page)).toHaveValue('');
  if (!queued) await expect(page.locator('.workspace .message.user').last()).toContainText(text);
}

test('arrows recall submitted text and restore the unsent draft without sending it', async ({
  page,
}) => {
  const f = await fixture(page);
  await submit(page, '第一条指令');
  await submit(page, '第二条指令');
  await box(page).fill('还没发的草稿');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('第二条指令');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('第一条指令');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('第一条指令');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('第二条指令');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('还没发的草稿');
  expect(f.requests.map((item) => item.text)).toEqual(['第一条指令', '第二条指令']);
});

test('history survives reload and stays isolated even between sessions in one project', async ({
  page,
}) => {
  const f = await fixture(page);
  await submit(page, '复用这条指令');
  await f.select(1);
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('');
  await f.select(2);
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('');
  await f.connect();
  await f.select(0);
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('复用这条指令');
});

test('editing history creates a new temporary draft and multiline arrows preserve caret movement', async ({
  page,
}) => {
  await fixture(page);
  await submit(page, 'previous');
  await box(page).press('ArrowUp');
  await box(page).fill('edited');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('previous');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('edited');
  await box(page).fill('first line\nsecond line');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('first line\nsecond line');
  await box(page).press('Control+Home');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('previous');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('first line\nsecond line');
});

test('a multiline historical command can be recalled and left without changing its line breaks', async ({
  page,
}) => {
  await fixture(page);
  await submit(page, 'older command');
  await submit(page, 'first line\nsecond line');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('first line\nsecond line');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('');
  await box(page).press('ArrowUp');
  await box(page).press('Control+Home');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('older command');
});

test('IME, modified arrows and selections cannot replace the current text', async ({ page }) => {
  await fixture(page);
  await submit(page, 'previous');
  await box(page).fill('中文草稿');
  await box(page).evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  await expect(box(page)).toHaveValue('中文草稿');
  await box(page).press('Shift+ArrowUp');
  await expect(box(page)).toHaveValue('中文草稿');
  await box(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 2));
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('中文草稿');
});

test('composition owns history and menu keys even when keyboard flags are missing', async ({
  page,
}) => {
  await fixture(page);
  await submit(page, 'previous command');
  await box(page).fill('中文草稿');
  await box(page).evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
  });
  await expect(box(page)).toHaveValue('中文草稿');
  await box(page).evaluate((element) =>
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })),
  );
  await box(page).fill('/');
  const menu = page.getByRole('listbox', { name: '会话命令' });
  await expect(menu).toBeVisible();
  const picked = menu.locator('[aria-selected="true"]');
  const before = (await picked.textContent())!;
  await box(page).evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await expect(menu).toBeVisible();
  await expect(picked).toHaveText(before);
});

test('composition closing keys never submit and ordinary Enter works after the guard', async ({
  page,
}) => {
  const f = await fixture(page);
  await submit(page, 'previous');
  await box(page).fill('confirmed Chinese text');
  await box(page).evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  await expect(box(page)).toHaveValue('confirmed Chinese text');
  expect(f.requests.map(({ text }) => text)).toEqual(['previous']);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await box(page).press('Enter');
  await expect(box(page)).toHaveValue('');
  expect(f.requests.map(({ text }) => text)).toEqual(['previous', 'confirmed Chinese text']);
});

test('native Chromium composition keeps candidate arrows and its closing Enter out of history and submission', async ({
  page,
}) => {
  const f = await fixture(page);
  await submit(page, 'previous');
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await expect(box(page)).toHaveValue('中文');
    await box(page).press('ArrowUp');
    await expect(box(page)).toHaveValue('中文');
    // Hold the clock across CDP round trips so this checks a closing key inside
    // the guard, independently of the test runner's scheduling latency.
    await page.evaluate(() => {
      const now = performance.now();
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    });
    await cdp.send('Input.insertText', { text: '中文' });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await expect(box(page)).toHaveValue('中文');
    expect(f.requests.map(({ text }) => text)).toEqual(['previous']);
    await page.evaluate(() => {
      delete (performance as any).now;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await box(page).press('Enter');
    await expect(box(page)).toHaveValue('');
    expect(f.requests.map(({ text }) => text)).toEqual(['previous', '中文']);
  } finally {
    await page.evaluate(() => {
      delete (performance as any).now;
    });
    await cdp.detach();
  }
});

test('a composition state from a previous session cannot disable another session input', async ({
  page,
}) => {
  const f = await fixture(page);
  await submit(page, 'session one command');
  await f.select(1);
  await submit(page, 'session two command');
  await box(page).evaluate((element) =>
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
  );
  await f.select(0);
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('session one command');
  await f.select(1);
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('session two command');
});

test('a failed send is not remembered and does not destroy the draft', async ({ page }) => {
  const f = await fixture(page);
  await submit(page, 'good');
  f.fail();
  await box(page).fill('failed');
  await box(page).press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'test send failure' })).toBeVisible();
  await expect(box(page)).toHaveValue('failed');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('good');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('failed');
});

test('queued input can be recalled before dispatch without sending an extra request', async ({
  page,
}) => {
  const f = await fixture(page);
  f.run();
  await submit(page, 'queued command', true);
  await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('queued command');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('queued command');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('');
  expect(f.requests).toHaveLength(0);
});

test('the slash menu owns arrows and recall restores the exact draft caret', async ({ page }) => {
  await fixture(page);
  await submit(page, 'previous');
  await box(page).fill('/');
  const menu = page.getByRole('listbox', { name: '会话命令' });
  await expect(menu).toBeVisible();
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('/');
  await expect(menu).toBeVisible();
  await box(page).fill('draft text');
  await box(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 3));
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('previous');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('draft text');
  expect(
    await box(page).evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([3, 3]);
});

test('switching chats while browsing history cannot restore another session draft', async ({
  page,
}) => {
  const f = await fixture(page);
  await submit(page, 'first history');
  await box(page).fill('first unsent');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('first history');
  await f.select(1);
  await box(page).fill('second unsent');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('second unsent');
  await f.select(0);
  await expect(box(page)).toHaveValue('first unsent');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('first unsent');
});

test('continuing a run cannot put a hidden service template into history', async ({ page }) => {
  const f = await fixture(page);
  await submit(page, 'real command');
  f.continuation();
  await expect(page.locator('.workspace .message.assistant').last()).toContainText(
    'continuation output received',
  );
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('real command');
});

test('a late send response cannot erase the original draft restored when leaving history', async ({
  page,
}) => {
  const f = await fixture(page);
  await submit(page, 'previous');
  await box(page).fill('original unsent');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('previous');
  f.hold();
  await box(page).press('Enter');
  await expect.poll(() => f.requests.length).toBe(2);
  await f.select(1, false);
  f.finishSend();
  await f.select(0);
  await expect(box(page)).toHaveValue('original unsent');
  expect(f.requests.map((item) => item.text)).toEqual(['previous', 'previous']);
});

test('native draft loading must finish before history can replace the input', async ({ page }) => {
  await page.addInitScript(() => {
    const noOp = () => {};
    const readers: ((saved: unknown) => void)[] = [];
    (window as any).finishDraftRead = (saved: unknown) =>
      readers.forEach((resolve) => resolve(saved));
    const api: Record<string, unknown> = {
      dev: true,
      platform: 'win32',
      boot: { connection: '', shared: { connections: [], busy: [] } },
      version: async () => '0.3.7',
      managedUpdate: undefined,
      managedServer: undefined,
      preview: undefined,
      access: undefined,
      windowSettings: async () => ({ closeToTray: false }),
      connections: async () => [],
      loadSchedules: async (text: string) => ({ path: '', text }),
      foldersExist: async (folders: string[]) => folders.map(() => true),
      workspaceRoots: async () => [],
      device: async () => ({ id: 'e04aef32-195f-48c0-a45a-34ebd8b0aa94', name: 'test' }),
      loadLogin: async () => null,
      loadDrafts: () => new Promise((resolve) => readers.push(resolve)),
      saveDrafts: async () => {},
      connectProxy: async () => ({ url: 'ws://127.0.0.1:18894/ws' }),
    };
    Object.defineProperty(window, 'desktop', {
      value: new Proxy(api, {
        get: (target, key) =>
          String(key) in target
            ? target[String(key)]
            : String(key).startsWith('on')
              ? () => noOp
              : async () => undefined,
      }),
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const f = await fixture(page, true);
  await expect(page.locator('.workspace .message.user').last()).toContainText('existing command');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('');
  await page.evaluate(
    (id) => (window as any).finishDraftRead({ [id]: 'saved original work' }),
    f.sessions[0].id,
  );
  await expect(box(page)).toHaveValue('saved original work');
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('existing command');
  await box(page).press('ArrowDown');
  await expect(box(page)).toHaveValue('saved original work');
  expect(errors).toEqual([]);
});
