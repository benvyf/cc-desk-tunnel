import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION, type Session, type SessionEvent } from '@cc-desk-tunnel/protocol';

const model = 'claude-3-7-sonnet-20250219-thinking-exp-v1.0.4-high-performance-runtime';
const thought = '**检查排版与图标**\n第二行需要保留完整单词 engineering 和路径。\n末行思考唯一词';
const notice = Array.from(
  { length: 8 },
  (_, n) => `第 ${n + 1} 项说明：${model}，请等待处理。`,
).join('\n');
const failure = Array.from({ length: 5 }, (_, n) => `错误详情第 ${n + 1} 行，请检查连接。`).join(
  '\n',
);
const responsiveNotice = '仅窄屏需要折叠的提示。'.repeat(8);

async function open(
  page: Page,
  completed = true,
  answer?: string,
  options: { thought?: string; notice?: string; mode?: 'standard' | 'expanded' } = {},
) {
  await page.addInitScript(
    (mode) => localStorage.setItem('proxy-prefs', JSON.stringify({ view: { mode } })),
    options.mode ?? 'expanded',
  );
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const thoughtId = randomUUID();
  const answerId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '中英文 Typography 与 Alignment 长标题的阅读体验和换行测试',
    autoTitle: false,
    projectPath: 'D:\\engineering\\一个很长的项目目录\\' + model,
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  let sequence = 0;
  const event = (payload: unknown) => ({
    sessionId: session.id,
    runId,
    sequence: ++sequence,
    createdAt: now,
    payload,
  });
  const events = [
    event({
      type: 'message.user',
      messageId: randomUUID(),
      text: '检查中英文混排、长模型名和展开交互。',
      scenario: 'chat',
    }),
    event({ type: 'thinking.delta', messageId: thoughtId, text: options.thought ?? thought }),
    event({
      type: 'text.delta',
      messageId: answerId,
      text:
        answer ??
        `## 中英文 Typography 与 Alignment 的排版和阅读体验\n\n这是已完成的正文。保留普通英文单词 engineering 的完整性，长模型标识符需要在窄屏安全换行：${model}。\n\n\`\`\`text\n${model.repeat(3)}\n\`\`\``,
    }),
    event({ type: 'native.notice', text: options.notice ?? notice }),
    event({ type: 'native.notice', text: '这是一条短提示。' }),
    event({ type: 'native.notice', text: responsiveNotice }),
    event({ type: 'run.error', code: 'test-only', message: failure }),
    ...(completed ? [event({ type: 'run.status', status: 'completed', connectionId })] : []),
  ];
  let finish = () => {};
  let emit = (_payload: SessionEvent['payload']) => {};
  await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    emit = (payload) => send({ type: 'session.event', event: event(payload) });
    finish = () =>
      send({
        type: 'session.event',
        event: event({ type: 'run.status', status: 'completed', connectionId }),
      });
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: false,
          events,
        });
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18894/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-typography-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const sidebar = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();
  await expect(page.locator('.message.assistant h2')).toBeVisible();
  return {
    finish,
    appendText: (text: string) => emit({ type: 'text.delta', messageId: answerId, text }),
    appendThought: (text: string) => emit({ type: 'thinking.delta', messageId: thoughtId, text }),
  };
}

test('capture typography on desktop and a narrow viewport', async ({ page }) => {
  await open(page);
  const folder = resolve('.local/screenshots/typography');
  mkdirSync(folder, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.mouse.move(5, 5);
    await page.locator('.conversation').evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({
      path: resolve(folder, `${process.env.TYPOGRAPHY_CAPTURE ?? 'after'}-${width}.png`),
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

test('thinking previews include subsequent lines and open fully with the keyboard', async ({
  page,
}) => {
  await open(page);
  await page.setViewportSize({ width: 390, height: 900 });
  const preview = page.locator('.thinking-preview');
  await expect(preview).toContainText('第二行需要保留完整单词 engineering');
  const height = await preview.evaluate((node) => ({
    actual: node.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(node).lineHeight),
  }));
  expect(height.actual).toBeLessThanOrEqual(height.line * 2 + 1);
  const summary = page.locator('.thinking-block > summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.thinking-block .tool-detail')).toContainText('末行思考唯一词');
});

test('only overflowing ordinary notices fold, and search temporarily reveals the full text', async ({
  page,
}) => {
  await open(page);
  const responsive = page.locator('.run-notice').filter({ hasText: responsiveNotice });
  await expect(responsive.getByRole('button')).toHaveCount(0);
  const long = page.locator('.run-notice').filter({ hasText: '第 8 项说明' });
  const text = long.locator('.run-notice-text');
  const toggle = long.getByRole('button', { name: '展开全文', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(
    await toggle.evaluate((node) => Boolean(node.closest('[role="status"], [role="alert"]'))),
  ).toBe(false);
  await expect(text).toHaveAttribute('role', 'status');
  const collapsed = await text.boundingBox();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(long.getByRole('button', { name: '收起', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  expect((await text.boundingBox())!.height).toBeGreaterThan(collapsed!.height);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: resolve('.local/screenshots/typography/expanded-1280.png') });
  await long.getByRole('button', { name: '收起', exact: true }).click();
  await expect(
    page.locator('.run-notice').filter({ hasText: '这是一条短提示。' }).getByRole('button'),
  ).toHaveCount(0);
  const error = page.locator('.run-notice.failed');
  await expect(error).toContainText('错误详情第 5 行');
  await expect(error.getByRole('button')).toHaveCount(0);
  expect(await error.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await page.keyboard.press('Control+f');
  await page.getByLabel('查找对话内容', { exact: true }).fill('第 8 项说明');
  expect((await text.boundingBox())!.height).toBeGreaterThan(collapsed!.height);
  await expect(long.getByRole('button')).toHaveCount(0);
  await page.getByLabel('查找对话内容', { exact: true }).press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(responsive.getByRole('button', { name: '展开全文', exact: true })).toBeVisible();
  await expect(toggle).toBeVisible();
  expect(
    await text.evaluate(
      (node) => node.clientHeight <= parseFloat(getComputedStyle(node).lineHeight) * 3 + 1,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (value: string) => {
        (window as unknown as { copied: string }).copied = value;
      },
    });
  });
  await text.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制整条消息', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(notice);
  await toggle.click();
  await page.mouse.move(5, 5);
  await page.screenshot({ path: resolve('.local/screenshots/typography/expanded-390.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(responsive.getByRole('button')).toHaveCount(0);
});

test('streaming prose uses ordinary wrapping until the turn completes', async ({ page }) => {
  const { finish } = await open(page, false);
  const content = page.locator('.message.assistant .message-content');
  await expect(content).toHaveClass(/streaming/);
  expect(await content.locator('p').evaluate((node) => getComputedStyle(node).textWrapStyle)).toBe(
    'auto',
  );
  await page.locator('.thinking-block > summary').click();
  const thinking = page.locator('.thinking-block .message-content');
  expect(await thinking.locator('p').evaluate((node) => getComputedStyle(node).textWrapStyle)).toBe(
    'auto',
  );
  finish();
  await expect(content).not.toHaveClass(/streaming/);
  expect(await content.locator('p').evaluate((node) => getComputedStyle(node).textWrapStyle)).toBe(
    'pretty',
  );
  expect(await thinking.locator('p').evaluate((node) => getComputedStyle(node).textWrapStyle)).toBe(
    'pretty',
  );
});

test('inline icon sizing preserves stretchy formulas and code controls inside lists', async ({
  page,
}) => {
  await open(
    page,
    true,
    '## 公式与控件\n\n$\\sqrt{abcdefgh}$ 与 $\\overbrace{a+b+c+d}$\n\n- $\\xrightarrow{long label}$\n\n  ```text\n  a long code line\n  ```',
  );
  const formulas = page.locator('.message.assistant .katex svg');
  await expect(formulas).toHaveCount(5);
  const sizes = await formulas.evaluateAll((nodes) =>
    nodes.map((node) => ({
      width: node.getBoundingClientRect().width,
      container: node.parentElement!.getBoundingClientRect().width,
    })),
  );
  for (const size of sizes) {
    expect(size.container).toBeGreaterThan(0);
    expect(size.width).toBeCloseTo(size.container, 0);
  }
  await expect(page.locator('.message.assistant li .copy-button svg')).toHaveCSS('width', '12px');
  await page.locator('.conversation').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.mouse.move(5, 5);
  await page.screenshot({
    path: resolve('.local/screenshots/typography/review-formulas-after.png'),
  });
});

test('text and disclosure controls stay within the conversation at small widths and double scale', async ({
  page,
}) => {
  await open(page);
  for (const theme of ['light', 'dark']) {
    for (const [width, zoom] of [
      [320, 1],
      [390, 1],
      [1280, 2],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(
        ({ theme, zoom }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.zoom = String(zoom);
        },
        { theme, zoom },
      );
      const conversation = page.locator('.conversation');
      const bounds = await conversation.boundingBox();
      const contents = await page
        .locator(
          '.thinking-block > summary, .message.assistant p, .run-notice-text, .notice-toggle',
        )
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right };
          }),
        );
      for (const rect of contents) {
        expect(rect.left, `${theme}, ${width}px, scale ${zoom}`).toBeGreaterThanOrEqual(bounds!.x);
        expect(rect.right, `${theme}, ${width}px, scale ${zoom}`).toBeLessThanOrEqual(
          bounds!.x + bounds!.width,
        );
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
  }
});

for (const activation of ['pointer', 'keyboard']) {
  test(`expanding a notice keeps its beginning in view instead of following to the end · ${activation}`, async ({
    page,
  }) => {
    await open(page, true, undefined, {
      notice: Array.from({ length: 80 }, (_, n) => `说明段落 ${n + 1}：需要从头阅读。`).join('\n'),
    });
    const text = page.locator('.run-notice-text').filter({ hasText: '说明段落 80' });
    const button = text.locator('..').getByRole('button');
    // Start at the end with following enabled, as when a new notice first arrives.
    await page.locator('.conversation').hover();
    await page.mouse.wheel(0, -400);
    await page.locator('.to-end-button').click();
    await expect(button).toBeInViewport();
    if (activation === 'pointer') await button.click();
    else {
      await button.focus();
      await button.press('Enter');
    }
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    // Wait for both React layout and the transcript's ResizeObserver follow-up.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const firstLine = await text.evaluate((node) => {
      const range = document.createRange();
      range.setStart(node.firstChild!, 0);
      range.setEnd(node.firstChild!, 4);
      const rect = range.getBoundingClientRect();
      const viewport = node.closest('.conversation')!.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, start: viewport.top, end: viewport.bottom };
    });
    expect(firstLine.top).toBeGreaterThanOrEqual(firstLine.start);
    expect(firstLine.bottom).toBeLessThanOrEqual(firstLine.end);
  });
}

for (const mode of ['standard', 'expanded'] as const) {
  test(`stretchy formulas keep their dimensions in opened thinking · ${mode}`, async ({ page }) => {
    await open(page, true, undefined, {
      mode,
      thought: '$\\sqrt{abcdefgh}$ 与 $\\overbrace{a+b+c+d}$',
    });
    if (mode === 'standard') {
      await page.locator('.turn-process > summary').click();
      await page.locator('.work > summary').click();
    }
    await page.locator('.thinking-block > summary').click();
    const formulas = page.locator('.thinking-block .katex svg');
    await expect(formulas).toHaveCount(4);
    for (const size of await formulas.evaluateAll((nodes) =>
      nodes.map((node) => ({
        width: node.getBoundingClientRect().width,
        parent: node.parentElement!.getBoundingClientRect().width,
      })),
    )) {
      expect(size.parent).toBeGreaterThan(0);
      expect(size.width).toBeCloseTo(size.parent, 0);
    }
  });
}

test('successive text and thinking chunks survive search and completion without duplicate matches', async ({
  page,
}) => {
  const stream = await open(page, false);
  await page.locator('.thinking-block > summary').focus();
  await page.keyboard.press('Enter');
  for (let n = 1; n <= 12; n++) {
    stream.appendText(`\n\n追加正文${n}：${model.repeat(3)}`);
    stream.appendThought(`\n追加思考${n}：${model}`);
  }
  const thinking = page.locator('.thinking-block .tool-detail');
  await expect(thinking).toContainText('追加思考12');
  await expect(page.locator('.message.assistant')).toContainText('追加正文12');
  await page.keyboard.press('Control+f');
  const find = page.getByLabel('查找对话内容', { exact: true });
  await find.fill('追加思考12');
  await expect(page.locator('.find-count')).toHaveText('1 / 1');
  stream.finish();
  await expect(page.locator('.message.assistant .message-content')).not.toHaveClass(/streaming/);
  await expect(thinking).toContainText('追加思考12');
  await expect(page.locator('.find-count')).toHaveText('1 / 1');
  await find.press('Escape');
  await expect(thinking).toBeVisible();
  await page.locator('.thinking-block > summary').click();
  await expect(thinking).toHaveCount(0);
  await expect(page.locator('.thinking-preview')).toContainText('追加思考12');
});

test('manual notice expansion survives search and narrow resize', async ({ page }) => {
  await open(page);
  const long = page.locator('.run-notice').filter({ hasText: '第 8 项说明' });
  await long.getByRole('button', { name: '展开全文', exact: true }).click();
  await page.keyboard.press('Control+f');
  const find = page.getByLabel('查找对话内容', { exact: true });
  await find.fill('第 8 项说明');
  await expect(page.locator('.find-count')).toHaveText('1 / 1');
  await page.setViewportSize({ width: 390, height: 900 });
  await find.fill('末行思考唯一词');
  await expect(page.locator('.find-count')).toHaveText('1 / 1');
  await find.fill('');
  await expect(long.getByRole('button', { name: '收起', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await find.press('Escape');
  await long.getByRole('button', { name: '收起', exact: true }).click();
  await expect(long.getByRole('button', { name: '展开全文', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});
