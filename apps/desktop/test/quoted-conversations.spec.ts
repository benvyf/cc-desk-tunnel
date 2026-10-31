import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { EventPayload, Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { splitQuoteMessage } from '../src/quotes.ts';

async function fixture(
  page: Page,
  {
    capable = true,
    busy = false,
    holdSide = false,
    foreignChild = false,
    delaySideCreation = false,
    longAnswer = false,
    delaySendAck = false,
  } = {},
) {
  const now = new Date().toISOString(),
    connectionId = randomUUID(),
    parentRun = randomUUID();
  const parent: Session = {
    id: randomUUID(),
    title: '主引用会话',
    projectPath: 'D:\\工作\\引用',
    autoTitle: false,
    permissionMode: 'auto',
    model: 'sonnet',
    effort: 'medium',
    createdAt: now,
    updatedAt: now,
    activeRun: busy ? { id: parentRun, status: 'running', connectionId } : null,
  };
  const sessions = [parent],
    events = new Map<string, SessionEvent[]>([[parent.id, []]]);
  const calls: Record<string, any>[] = [],
    created: string[] = [];
  let send = (value: unknown) => {};
  let finishSide = () => {};
  let finishSend = () => {};
  function add(sessionId: string, payload: EventPayload, runId: string = parentRun) {
    const list = events.get(sessionId) ?? [];
    const event = { sessionId, runId, sequence: list.length + 1, createdAt: now, payload };
    list.push(event);
    events.set(sessionId, list);
    return event;
  }
  const models = ['sonnet', 'opus'].map((value) => ({
    value,
    displayName: value === 'sonnet' ? 'Sonnet' : 'Opus',
    description: '',
    source: 'native' as const,
    supportedEffortLevels: ['low', 'medium', 'high'] as const,
  }));
  add(parent.id, {
    type: 'native.capabilities',
    account: {},
    commands: [],
    models: models.map((m) => ({ ...m, supportedEffortLevels: [...m.supportedEffortLevels] })),
  });
  add(parent.id, {
    type: 'message.user',
    messageId: randomUUID(),
    text: '请解释这些功能',
    scenario: 'chat',
  });
  const answer =
    '# 引用交互\n\n自动刷新只更新当前文件。侧边会话独立保存。\n\n请由用户输入问题后再发送。' +
    (longAnswer ? '\n\n长回答里的引用片段。'.repeat(80) : '');
  add(parent.id, { type: 'text.delta', messageId: randomUUID(), text: answer });
  add(parent.id, { type: 'run.status', status: busy ? 'running' : 'completed', connectionId });
  await page.routeWebSocket('ws://127.0.0.1:18903/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      calls.push(message);
      const respond = (id?: string) =>
        send({ type: 'response', requestId: message.requestId, ok: true, sessionId: id });
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId,
          adapter: 'claude-code',
          sessions,
          ...(capable ? { sideConversations: true } : {}),
        });
        return;
      }
      if (message.type === 'session.subscribe') {
        const session = sessions.find((s) => s.id === message.sessionId)!;
        const list = events.get(session.id) ?? [];
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
        respond(session.id);
        return;
      }
      if (message.type === 'session.side.create') {
        const source = sessions.find((s) => s.id === message.sessionId)!;
        const child: Session = {
          ...source,
          id: randomUUID(),
          title: message.title,
          activeRun: null,
          sideConversation: {
            parentSessionId: source.id,
            throughSequence: events.get(source.id)?.length ?? 0,
            createdAt: now,
          },
        };
        sessions.push(child);
        created.push(child.id);
        events.set(child.id, []);
        send({ type: 'session.updated', session: child });
        finishSide = () => respond(child.id);
        if (!delaySideCreation) finishSide();
        return;
      }
      if (message.type === 'session.configure') {
        const session = sessions.find((s) => s.id === message.sessionId)!;
        for (const key of ['model', 'effort', 'permissionMode'] as const)
          if (key in message) (session as any)[key] = message[key];
        send({ type: 'session.updated', session });
        respond(session.id);
        return;
      }
      if (message.type === 'message.send') {
        const session = sessions.find((s) => s.id === message.sessionId)!,
          runId = randomUUID();
        session.activeRun = {
          id: runId,
          status: 'running',
          connectionId: foreignChild && session.id !== parent.id ? randomUUID() : connectionId,
        };
        send({ type: 'session.updated', session });
        send({
          type: 'session.event',
          event: add(
            session.id,
            {
              type: 'message.user',
              messageId: message.requestId,
              text: message.text,
              scenario: 'chat',
            },
            runId,
          ),
        });
        send({
          type: 'session.event',
          event: add(
            session.id,
            {
              type: 'text.delta',
              messageId: randomUUID(),
              text: session.id === parent.id ? '主会话继续回答' : '侧边会话独立回答',
            },
            runId,
          ),
        });
        if (!holdSide || session.id === parent.id) {
          session.activeRun = null;
          send({
            type: 'session.event',
            event: add(
              session.id,
              { type: 'run.status', status: 'completed', connectionId },
              runId,
            ),
          });
          send({ type: 'session.updated', session });
        }
        finishSend = () => respond(session.id);
        if (!delaySendAck) finishSend();
        return;
      }
      if (message.type === 'run.cancel') {
        const session = sessions.find((s) => s.id === message.sessionId)!;
        const runId = session.activeRun!.id;
        session.activeRun = null;
        send({
          type: 'session.event',
          event: add(session.id, { type: 'run.status', status: 'cancelled', connectionId }, runId),
        });
        send({ type: 'session.updated', session });
        respond(session.id);
        return;
      }
      respond(message.sessionId);
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18903/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('quote-fixture-token-with-enough-characters');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page
    .locator('.session-row')
    .filter({ hasText: parent.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.workspace .message.assistant')).toContainText('自动刷新');
  return {
    parent,
    sessions,
    events,
    calls,
    created,
    answer,
    finishSide: () => finishSide(),
    finishSend: () => finishSend(),
    messages: () => calls.filter((c) => c.type === 'message.send'),
  };
}
async function selectAnswer(page: Page, text: string) {
  const content = page.locator('.workspace .message.assistant [data-copy-text]').last();
  await content.scrollIntoViewIfNeeded();
  await content.evaluate((element, text) => {
    const doc = element.ownerDocument,
      walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at >= 0) {
        const range = doc.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const selection = doc.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        break;
      }
    }
  }, text);
  await expect(page.getByRole('toolbar', { name: '引用选中文字' })).toBeVisible();
}

test('mouse drag selection offers both quote destinations and preserves exactly the selected text', async ({
  page,
}) => {
  const f = await fixture(page),
    main = page.locator('.workspace');
  for (const destination of ['main', 'side']) {
    const paragraph = main.locator('.message.assistant [data-copy-text] p').first();
    await paragraph.scrollIntoViewIfNeeded();
    const points = await paragraph.evaluate((el) => {
      const node = el.firstChild!,
        text = node.textContent!,
        end = text.indexOf('。');
      const first = el.ownerDocument.createRange(),
        last = el.ownerDocument.createRange();
      first.setStart(node, 0);
      first.setEnd(node, 1);
      last.setStart(node, end - 1);
      last.setEnd(node, end);
      const a = first.getBoundingClientRect(),
        b = last.getBoundingClientRect();
      return {
        from: { x: a.left + 1, y: a.top + a.height / 2 },
        to: { x: b.right - 1, y: b.top + b.height / 2 },
      };
    });
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    await page.mouse.move(points.to.x, points.to.y, { steps: 12 });
    await page.mouse.up();
    const toolbar = page.getByRole('toolbar', { name: '引用选中文字', exact: true });
    await expect(toolbar).toBeVisible();
    const selected = await page.evaluate(() => getSelection()?.toString() ?? '');
    expect(selected).toContain('自动刷新');
    await expect(toolbar.getByRole('button', { name: '添加到对话', exact: true })).toBeVisible();
    await expect(
      toolbar.getByRole('button', { name: '在侧边聊天中提问', exact: true }),
    ).toBeEnabled();
    await toolbar
      .getByRole('button', {
        name: destination === 'main' ? '添加到对话' : '在侧边聊天中提问',
        exact: true,
      })
      .click();
    const target =
      destination === 'main' ? main : page.getByRole('region', { name: '侧边会话', exact: true });
    await target.getByRole('button', { name: '查看引用内容', exact: true }).click();
    await expect(target.locator('.composer-input .quote-reference-item blockquote')).toHaveText(
      selected,
    );
    await expect(target.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
    await expect(target.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    expect(f.messages()).toHaveLength(0);
  }
});

test('main quote is an atomic editable reference and sends only the explicit question in the original session', async ({
  page,
}) => {
  const f = await fixture(page);
  const main = page.locator('.workspace'),
    box = main.getByRole('textbox', { name: '消息', exact: true });
  await box.fill('保留原有草稿');
  await main.getByRole('button', { name: '引用回答', exact: true }).last().click();
  await expect(box).toHaveValue('保留原有草稿');
  await expect(box).toBeFocused();
  await expect(main.locator('.composer-input')).toContainText('1 条引用');
  await expect(
    main.getByRole('button', { name: '查看引用内容', exact: true }),
  ).toHaveAccessibleDescription('1 条引用');
  expect(f.messages()).toHaveLength(0);
  await main.getByRole('button', { name: '查看引用内容', exact: true }).click();
  await expect(main.locator('.quote-reference-list')).toContainText('自动刷新只更新当前文件');
  await main.getByRole('button', { name: '移除引用', exact: true }).click();
  await expect(box).toHaveValue('保留原有草稿');
  await main.getByRole('button', { name: '引用回答', exact: true }).last().click();
  await box.fill('解释引用中的这句话');
  await main.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => f.messages().length).toBe(1);
  expect(f.messages()[0].sessionId).toBe(f.parent.id);
  expect(splitQuoteMessage(f.messages()[0].text)).toMatchObject({
    text: '解释引用中的这句话',
    quotes: [{ sessionId: f.parent.id, text: f.answer }],
  });
  await expect(main.locator('.message.user').last()).toContainText('解释引用中的这句话');
  await expect(main.locator('.message.user').last()).not.toContainText('CC SPACE 引用消息');
});

test('selected quote opens an independent side conversation with explicit send and isolated model settings', async ({
  page,
}) => {
  const f = await fixture(page),
    main = page.locator('.workspace'),
    mainBox = main.getByRole('textbox', { name: '消息', exact: true });
  await mainBox.fill('主会话草稿保持原样');
  await selectAnswer(page, '自动刷新');
  await page
    .getByRole('toolbar', { name: '引用选中文字' })
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .click();
  const side = page.getByRole('region', { name: '侧边会话', exact: true });
  await expect(side).toBeVisible();
  expect(f.messages()).toHaveLength(0);
  expect(f.created).toHaveLength(1);
  await expect(mainBox).toHaveValue('主会话草稿保持原样');
  await expect(page.locator('.session-row.selected')).toContainText(f.parent.title);
  await expect(side.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await side.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  await side.locator('.model-current').click();
  await side.getByRole('option', { name: 'Opus', exact: true }).click();
  await expect.poll(() => f.sessions[1].model).toBe('opus');
  expect(f.parent.model).toBe('sonnet');
  await side.getByRole('textbox', { name: '消息', exact: true }).fill('解释这个概念');
  await side.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => f.messages().length).toBe(1);
  expect(f.messages()[0].sessionId).toBe(f.created[0]);
  expect(splitQuoteMessage(f.messages()[0].text)).toMatchObject({
    text: '解释这个概念',
    quotes: [{ text: '自动刷新' }],
  });
  await expect(side).toContainText('侧边会话独立回答');
  await expect(mainBox).toHaveValue('主会话草稿保持原样');
});

test('a running main conversation is not stopped or sent to when stopping a side answer', async ({
  page,
}) => {
  const f = await fixture(page, { busy: true, holdSide: true }),
    main = page.locator('.workspace');
  await selectAnswer(page, '自动刷新');
  await page
    .getByRole('toolbar', { name: '引用选中文字' })
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .click();
  const side = page.getByRole('region', { name: '侧边会话', exact: true });
  await side.getByRole('textbox', { name: '消息', exact: true }).fill('只在侧边回答');
  await side.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(side.getByRole('button', { name: '停止运行', exact: true })).toBeEnabled();
  const parentRun = f.parent.activeRun!.id;
  await side.getByRole('button', { name: '停止运行', exact: true }).click();
  await expect.poll(() => f.calls.filter((c) => c.type === 'run.cancel').length).toBe(1);
  expect(f.calls.find((c) => c.type === 'run.cancel')!.sessionId).toBe(f.created[0]);
  expect(f.parent.activeRun!.id).toBe(parentRun);
  expect(f.messages().every((c) => c.sessionId !== f.parent.id)).toBe(true);
  await expect(main.getByRole('button', { name: '停止运行', exact: true })).toBeEnabled();
});

test('old nodes keep main quote available and disable side creation without a local fallback', async ({
  page,
}) => {
  const f = await fixture(page, { capable: false });
  await expect(page.getByRole('button', { name: '引用回答', exact: true }).last()).toBeEnabled();
  await expect(
    page
      .locator('.workspace')
      .getByRole('button', { name: '在侧边聊天中提问', exact: true })
      .last(),
  ).toBeDisabled();
  expect(f.created).toHaveLength(0);
  expect(f.messages()).toHaveLength(0);
});

test('multiple side tabs keep separate drafts and quote chips after switching', async ({
  page,
}) => {
  const f = await fixture(page),
    main = page.locator('.workspace');
  await selectAnswer(page, '自动刷新');
  await page
    .getByRole('toolbar', { name: '引用选中文字' })
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .click();
  const side = page.getByRole('region', { name: '侧边会话', exact: true });
  await side.getByRole('textbox', { name: '消息', exact: true }).fill('第一份侧栏草稿');
  await selectAnswer(page, '侧边会话独立保存');
  await page
    .getByRole('toolbar', { name: '引用选中文字' })
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .click();
  await expect.poll(() => f.created.length).toBe(2);
  await expect(side.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
  await side.getByRole('textbox', { name: '消息', exact: true }).fill('第二份侧栏草稿');
  await page.getByRole('tab', { name: '追问 · 自动刷新', exact: true }).click();
  await expect(side.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '第一份侧栏草稿',
  );
  await side.getByRole('button', { name: '查看引用内容', exact: true }).click();
  await expect(side.locator('.quote-reference-list')).toHaveText(/自动刷新/);
  await page.getByRole('tab', { name: '追问 · 侧边会话独立保存', exact: true }).click();
  await expect(side.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '第二份侧栏草稿',
  );
  await expect(main.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
  expect(f.messages()).toHaveLength(0);
});

test('queued quote editing exposes the question and preserves its reference', async ({ page }) => {
  const f = await fixture(page, { busy: true }),
    main = page.locator('.workspace'),
    box = main.getByRole('textbox', { name: '消息', exact: true });
  await selectAnswer(page, '自动刷新');
  await page
    .getByRole('toolbar', { name: '引用选中文字' })
    .getByRole('button', { name: '添加到对话', exact: true })
    .click();
  await box.fill('等待中的问题');
  await main.getByRole('button', { name: '排队发送', exact: true }).click();
  const queue = main.getByRole('region', { name: '待发送消息', exact: true });
  await expect(queue).toContainText('等待中的问题');
  expect(f.messages()).toHaveLength(0);
  await queue.getByRole('button', { name: '编辑排队消息', exact: true }).click();
  const editor = queue.getByRole('textbox', { name: '编辑排队消息', exact: true });
  await expect(editor).toHaveValue('等待中的问题');
  await editor.fill('');
  await expect(queue.getByRole('button', { name: '保存排队消息', exact: true })).toBeDisabled();
  await editor.fill('修改后的问题');
  await queue.getByRole('button', { name: '保存排队消息', exact: true }).click();
  await expect(queue).toContainText('1 条引用');
  await queue.getByRole('button', { name: '插话发送此消息', exact: true }).click();
  await expect.poll(() => f.messages().length).toBe(1);
  expect(splitQuoteMessage(f.messages()[0].text)).toMatchObject({
    text: '修改后的问题',
    quotes: [{ text: '自动刷新' }],
  });
});

test('quote drafts restore after reload without sending', async ({ page }) => {
  const f = await fixture(page),
    main = page.locator('.workspace');
  await main.getByRole('button', { name: '引用回答', exact: true }).last().click();
  await main.getByRole('textbox', { name: '消息', exact: true }).fill('保留到下次打开');
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('proxy-drafts') ?? '{}')))
    .toHaveProperty(f.parent.id);
  await page.reload();
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('quote-fixture-token-with-enough-characters');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page
    .locator('.session-row')
    .filter({ hasText: f.parent.title })
    .locator('.session-select')
    .click();
  await expect(main.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '保留到下次打开',
  );
  await expect(main.locator('.composer-input')).toContainText('1 条引用');
  expect(f.messages()).toHaveLength(0);
});

test('user text and selections spanning messages never become quote actions', async ({ page }) => {
  const f = await fixture(page);
  for (const cross of [false, true]) {
    await page.locator('.workspace .conversation').evaluate((root, cross) => {
      const doc = root.ownerDocument,
        user = root.querySelector('.message.user [data-copy-text]')!,
        answer = root.querySelector('.message.assistant [data-copy-text]')!;
      const range = doc.createRange();
      range.selectNodeContents(user);
      if (cross) range.setEndAfter(answer);
      const selection = doc.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, cross);
    await expect(page.getByRole('toolbar', { name: '引用选中文字' })).toHaveCount(0);
    await page
      .locator('.workspace .message.user')
      .dispatchEvent('contextmenu', { clientX: 450, clientY: 200 });
    const menu = page.getByRole('menu', { name: '对话文字操作' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '添加到对话', exact: true })).toHaveCount(0);
    await menu.press('Escape');
  }
  expect(f.messages()).toHaveLength(0);
  expect(f.created).toHaveLength(0);
});

test('context menu quotes the captured selection even after focus clears the browser selection', async ({
  page,
}) => {
  const f = await fixture(page);
  await selectAnswer(page, '自动刷新');
  await page
    .locator('.workspace .message.assistant')
    .dispatchEvent('contextmenu', { clientX: 450, clientY: 200 });
  const menu = page.getByRole('menu', { name: '对话文字操作' });
  await expect(menu).toBeVisible();
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await menu.getByRole('menuitem', { name: '添加到对话', exact: true }).click();
  await expect(page.locator('.workspace .composer-input')).toContainText('1 条引用');
  expect(f.messages()).toHaveLength(0);
});

test('side runs remain controllable after their original peer changes', async ({ page }) => {
  const f = await fixture(page, { holdSide: true, foreignChild: true });
  await page
    .locator('.workspace')
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .last()
    .click();
  const side = page.getByRole('region', { name: '侧边会话', exact: true });
  await side.getByRole('textbox', { name: '消息', exact: true }).fill('继续独立追问');
  await side.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(side.getByRole('button', { name: '停止运行', exact: true })).toBeEnabled();
  await side.getByRole('button', { name: '停止运行', exact: true }).click();
  await expect.poll(() => f.calls.filter((c) => c.type === 'run.cancel').length).toBe(1);
});

test('side permission and model menus remain usable across themes and narrow layouts', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page
    .locator('.workspace')
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .last()
    .click();
  const side = page.getByRole('region', { name: '侧边会话', exact: true });
  for (const [width, height, theme, font] of [
    [1280, 800, 'light', 16],
    [900, 650, 'dark', 20],
    [390, 800, 'light', 18],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      ({ theme, font }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty('--font-body', `${font}px`);
      },
      { theme, font },
    );
    await side.getByRole('button', { name: '审批模式', exact: true }).click();
    await side.getByRole('menuitemradio', { name: '手动审批', exact: true }).click();
    await expect.poll(() => f.sessions[1].permissionMode).toBe('default');
    await side.getByRole('button', { name: '审批模式', exact: true }).click();
    await side.getByRole('menuitemradio', { name: '自动审批', exact: true }).click();
    await side.getByRole('button', { name: '模型与推理强度', exact: true }).click();
    await side.locator('.model-current').click();
    await side.getByRole('option', { name: 'Opus', exact: true }).click();
    await expect(side.getByRole('dialog', { name: '模型与推理强度', exact: true })).toHaveCount(0);
    await expect(side.getByRole('menu', { name: '审批模式', exact: true })).toHaveCount(0);
    await expect(side.locator('.motion-presence[data-state="exit"]')).toHaveCount(0);
    await side.getByRole('textbox', { name: '消息', exact: true }).fill('布局检查中的问题');
    await page.screenshot({
      path: info.outputPath(`quote-${width}-${theme}.png`),
      animations: 'disabled',
    });
  }
  expect(f.parent.permissionMode).toBe('auto');
  expect(f.parent.model).toBe('sonnet');
  expect(f.messages()).toHaveLength(0);
});

test('delayed side creation stays on its originating board after main navigation', async ({
  page,
}) => {
  const f = await fixture(page, { delaySideCreation: true });
  await page
    .locator('.workspace')
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .last()
    .click();
  await expect.poll(() => f.created.length).toBe(1);
  const child = f.sessions[1];
  await page
    .locator('.session-row')
    .filter({ hasText: child.title })
    .locator('.session-select')
    .click();
  await page
    .locator('.workspace')
    .getByRole('textbox', { name: '消息', exact: true })
    .fill('切换后的草稿');
  f.finishSide();
  await expect(page.locator('.session-row.selected')).toContainText(child.title);
  await expect(page.getByRole('region', { name: '侧边会话', exact: true })).toHaveCount(0);
  await page
    .locator('.session-row')
    .filter({ hasText: f.parent.title })
    .locator('.session-select')
    .click();
  const side = page.getByRole('region', { name: '侧边会话', exact: true });
  await expect(side).toBeVisible();
  await expect(side.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '切换后的草稿',
  );
  await expect(side.locator('.composer-input')).toContainText('1 条引用');
  expect(f.messages()).toHaveLength(0);
});

test('floating side chats keep their composer and permission menu reachable at minimum size', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ fontSizes: { interface: 20, code: 13 } })),
  );
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page
    .locator('.workspace')
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .last()
    .click();
  await page.getByRole('button', { name: '浮动预览', exact: true }).click();
  const floating = page.locator('.preview-pane-floating'),
    handle = floating.getByRole('separator', { name: '调整浮窗大小', exact: true });
  await handle.focus();
  for (let i = 0; i < 30; i++) await handle.press('ArrowUp');
  const side = floating.getByRole('region', { name: '侧边会话', exact: true });
  await expect
    .poll(() =>
      side.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        return [...el.querySelectorAll('textarea,.composer-toolbar')].every((item) => {
          const box = item.getBoundingClientRect();
          return box.top >= bounds.top && box.bottom <= bounds.bottom && box.height >= 40;
        });
      }),
    )
    .toBe(true);
  await side.getByRole('textbox', { name: '消息', exact: true }).fill('最小浮窗仍能输入');
  await side.getByRole('button', { name: '审批模式', exact: true }).click();
  await side.getByRole('menuitemradio', { name: '手动审批', exact: true }).click();
  await expect(side.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
});

test('long selections keep both quote actions inside the viewport at maximum font size', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ fontSizes: { interface: 20, code: 13 } })),
  );
  await fixture(page, { longAnswer: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await page.locator('.workspace .conversation').evaluate(async (root) => {
      root.scrollTop = (root.scrollHeight - root.clientHeight) / 2;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const doc = root.ownerDocument,
        content = root.querySelector('.message.assistant [data-copy-text]')!,
        range = doc.createRange();
      range.selectNodeContents(content);
      const selection = doc.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const toolbar = page.getByRole('toolbar', { name: '引用选中文字', exact: true });
    await expect(toolbar).toBeVisible();
    await expect
      .poll(() =>
        toolbar.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          return (
            bounds.left >= 8 &&
            bounds.top >= 8 &&
            bounds.right <= innerWidth - 8 &&
            bounds.bottom <= innerHeight - 8 &&
            el.scrollWidth <= el.clientWidth
          );
        }),
      )
      .toBe(true);
  }
});

test('short split chats let users scroll to the composer without automatic locator scrolling', async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  for (let i = 0; i < 2; i++)
    await page
      .locator('.workspace')
      .getByRole('button', { name: '在侧边聊天中提问', exact: true })
      .last()
      .click();
  await page.getByRole('button', { name: '分栏预览', exact: true }).click();
  const sides = page.getByRole('region', { name: '侧边会话', exact: true });
  await expect(sides).toHaveCount(2);
  for (const side of await sides.all()) {
    await side.locator('.side-conversation-source').hover();
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() =>
        side.evaluate((el) => {
          const bounds = el.getBoundingClientRect(),
            box = el.querySelector('textarea')!.getBoundingClientRect();
          return box.top >= bounds.top && box.bottom <= bounds.bottom;
        }),
      )
      .toBe(true);
    await side.getByRole('button', { name: '审批模式', exact: true }).click();
    const menu = side.getByRole('menu', { name: '审批模式', exact: true });
    await expect(menu).toBeVisible();
    await side.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect
      .poll(() =>
        menu.evaluate((el) => {
          const bounds = el.closest('.side-conversation')!.getBoundingClientRect(),
            box = el.getBoundingClientRect();
          return box.top >= bounds.top && box.bottom <= bounds.bottom;
        }),
      )
      .toBe(true);
    await menu.press('Escape');
  }
});

test('selection tools dismiss when another workspace control is used', async ({ page }) => {
  await fixture(page);
  await page
    .locator('.workspace')
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .last()
    .click();
  await selectAnswer(page, '自动刷新');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: '引用选中文字', exact: true })).toHaveCount(0);
  await selectAnswer(page, '自动刷新');
  await page.getByRole('button', { name: '浮动预览', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: '引用选中文字', exact: true })).toHaveCount(0);
});

test('a delayed side send cannot erase a newer draft when its chat moves into main', async ({
  page,
}) => {
  const f = await fixture(page, { delaySendAck: true });
  await page
    .locator('.workspace')
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .last()
    .click();
  const side = page.getByRole('region', { name: '侧边会话', exact: true });
  await side.getByRole('textbox', { name: '消息', exact: true }).fill('第一条已发送问题');
  await side.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => f.messages().length).toBe(1);
  await page
    .locator('.session-row')
    .filter({ hasText: f.sessions[1].title })
    .locator('.session-select')
    .click();
  const box = page.locator('.workspace').getByRole('textbox', { name: '消息', exact: true });
  await box.fill('确认返回之前新写的草稿');
  f.finishSend();
  await expect(page.locator('.workspace .composer-input .quote-reference-chip')).toHaveCount(0);
  await expect(box).toHaveValue('确认返回之前新写的草稿');
  expect(f.messages()).toHaveLength(1);
});

test('a delayed main send preserves newer edits made after returning to its side pane', async ({
  page,
}) => {
  const f = await fixture(page, { delaySendAck: true });
  const main = page.locator('.workspace');
  await main.getByRole('button', { name: '在侧边聊天中提问', exact: true }).last().click();
  const side = page.getByRole('region', { name: '侧边会话', exact: true });
  await side.getByRole('textbox', { name: '消息', exact: true }).fill('建立侧会话记录');
  await side.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => f.messages().length).toBe(1);
  f.finishSend();
  await expect(side.locator('.composer-input .quote-reference-chip')).toHaveCount(0);
  await page
    .locator('.session-row')
    .filter({ hasText: f.sessions[1].title })
    .locator('.session-select')
    .click();
  await main.getByRole('textbox', { name: '消息', exact: true }).fill('从主窗口发送的问题');
  await main.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => f.messages().length).toBe(2);
  await page
    .locator('.session-row')
    .filter({ hasText: f.parent.title })
    .locator('.session-select')
    .click();
  const box = side.getByRole('textbox', { name: '消息', exact: true });
  await box.fill('等待期间在侧栏写的新草稿');
  f.finishSend();
  await expect(main.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  await expect(box).toHaveValue('等待期间在侧栏写的新草稿');
  expect(f.messages()).toHaveLength(2);
});

test('typing with quote controls does not reinstall document selection listeners', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const probe = { added: 0, removed: 0 };
    (window as any).selectionListenerProbe = probe;
    const add = EventTarget.prototype.addEventListener,
      remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, ...args) {
      if (this === document && type === 'selectionchange') probe.added++;
      return add.call(this, type, ...args);
    };
    EventTarget.prototype.removeEventListener = function (type, ...args) {
      if (this === document && type === 'selectionchange') probe.removed++;
      return remove.call(this, type, ...args);
    };
  });
  await fixture(page);
  await page
    .locator('.workspace')
    .getByRole('button', { name: '在侧边聊天中提问', exact: true })
    .last()
    .click();
  await expect(page.getByRole('region', { name: '侧边会话', exact: true })).toBeVisible();
  const before = await page.evaluate(() => ({ ...(window as any).selectionListenerProbe }));
  await page
    .locator('.workspace')
    .getByRole('textbox', { name: '消息', exact: true })
    .pressSequentially('typing should keep listeners stable');
  const after = await page.evaluate(() => ({ ...(window as any).selectionListenerProbe }));
  console.log(
    'selection listener installs during typing',
    after.added - before.added,
    'removals',
    after.removed - before.removed,
  );
  expect(after.added - before.added).toBeLessThanOrEqual(2);
  expect(after.removed - before.removed).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: '收起预览', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).selectionListenerProbe.removed))
    .toBe(after.removed + 1);
  const collapsed = await page.evaluate(() => ({ ...(window as any).selectionListenerProbe }));
  await page
    .locator('.workspace')
    .getByRole('textbox', { name: '消息', exact: true })
    .pressSequentially('after collapse');
  const final = await page.evaluate(() => ({ ...(window as any).selectionListenerProbe }));
  expect(final).toEqual(collapsed);
});
