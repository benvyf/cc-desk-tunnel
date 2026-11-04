import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// A question looks as it does in Claude Desktop: Markdown on a 12px rounded bubble, long ones folded, attached files
// above the bubble.
const paragraph =
  '第二，渲染进程里有一个很长的列表，滚动的时候偶尔会白屏一下，大概一两帧，打开 DevTools 的性能面板能看到有一次很长的样式重算。';
const markdown = `带列表和代码的问题：
这段代码为什么会重复渲染？

- React 19
- 父组件每秒更新一次

公式 $a^2$ 原样

\`\`\`tsx
const [state, setState] = useState(value);
\`\`\``;
const middling = Array.from({ length: 4 }, () => paragraph).join('\n\n');
const pasted = [...Array.from({ length: 14 }, () => paragraph), '最后一段里才有的词：鹈鹕'].join(
  '\n\n',
);
const attached = '看看这两个文件\n"C:\\资料\\配置指南.md"\n"C:\\资料\\schema.json"';
const filesOnly = '"C:\\资料\\只有附件.pdf"';
const questions = [markdown, middling, pasted, attached, filesOnly];

async function open(page: Page) {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '气泡',
    autoTitle: false,
    projectPath: 'D:\\工作\\气泡',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  await page.routeWebSocket('ws://127.0.0.1:18893/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    let sequence = 0;
    const events = questions.flatMap((text) => {
      const runId = randomUUID();
      const event = (payload: unknown) => ({
        sessionId: session.id,
        runId,
        sequence: ++sequence,
        createdAt: now,
        payload,
      });
      return [
        event({ type: 'message.user', messageId: randomUUID(), text, scenario: 'chat' }),
        event({ type: 'text.delta', messageId: randomUUID(), text: '好的。' }),
        event({ type: 'run.status', status: 'completed', connectionId }),
      ];
    });
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
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18893/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-bubble-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator('.session-row').filter({ hasText: '气泡' }).locator('.session-select').click();
  await expect(page.locator('.message.user')).toHaveCount(questions.length);
  return page.locator('.message.user');
}

test('a question is Markdown on a Claude-shaped bubble and copies as it was written', async ({
  page,
}) => {
  const users = await open(page);
  const first = users.nth(0);
  const bubble = first.locator('.user-bubble');
  await expect(bubble).toHaveCSS('border-radius', '12px');
  await expect(bubble).toHaveCSS('padding', '10px 14px');
  await expect(bubble).toHaveCSS('background-color', 'rgb(240, 239, 236)');
  await expect(bubble.locator('p').first()).toHaveCSS('font-size', '14px');
  // A typed line break stays one; a list and a block of code are themselves.
  await expect(bubble.locator('p').first()).toHaveText(
    '带列表和代码的问题：\n这段代码为什么会重复渲染？',
    { useInnerText: true },
  );
  await expect(bubble.locator('li')).toHaveText(['React 19', '父组件每秒更新一次']);
  await expect(bubble.locator('pre')).toContainText('useState(value)');
  await expect(bubble.locator('.code-header')).toBeHidden();
  // The user's own words: no formula is typeset.
  await expect(bubble.locator('.katex')).toHaveCount(0);
  await expect(bubble).toContainText('公式 $a^2$ 原样');
  await expect(first.locator('.message-content')).toHaveAttribute('data-copy-text', markdown);
});

test('a long question folds to its first lines and opens on demand; one a little long does not', async ({
  page,
}) => {
  const users = await open(page);
  await expect(users.nth(1).locator('.user-text')).not.toHaveAttribute('data-folded');
  await expect(users.nth(1).locator('.bubble-fold')).toHaveCount(0);
  const long = users.nth(2);
  const text = long.locator('.user-text');
  const toggle = long.getByRole('button', { name: '展开', exact: true });
  await long.scrollIntoViewIfNeeded();
  await expect(text).toHaveAttribute('data-folded', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const folded = (await text.boundingBox())!.height;
  expect(folded).toBeLessThan(200);
  await toggle.click();
  const fold = long.getByRole('button', { name: '收起', exact: true });
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(text).not.toHaveAttribute('data-folded');
  expect((await text.boundingBox())!.height).toBeGreaterThan(folded * 3);
  await fold.click();
  await expect(text).toHaveAttribute('data-folded', 'true');
});

test('searching the conversation opens a folded question to its match', async ({ page }) => {
  const users = await open(page);
  const text = users.nth(2).locator('.user-text');
  await text.scrollIntoViewIfNeeded();
  await expect(text).toHaveAttribute('data-folded', 'true');
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: '查找对话内容', exact: true }).fill('鹈鹕');
  await expect(page.locator('.find-count')).toHaveText(/1 \/ 1/);
  await expect(text).not.toHaveAttribute('data-folded');
  await expect(users.nth(2).locator('.bubble-fold')).toHaveCount(0);
  await expect(text.getByText(/鹈鹕/)).toBeInViewport();
});

test('attached files stand above the bubble as small tiles; files alone have no bubble', async ({
  page,
}) => {
  const users = await open(page);
  const withText = users.nth(3);
  const cards = withText.locator('.message-attachments [role="listitem"]');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('配置指南.md');
  await expect(cards.first().locator('.attachment-kind')).toHaveText('MD');
  // The input box's tiles: 128 × 96.
  const tile = (await cards.first().locator('.attachment-tile').boundingBox())!;
  expect([tile.width, tile.height]).toEqual([128, 96]);
  await expect(withText.locator('.user-bubble .attachment-tile')).toHaveCount(0);
  const above = (await withText.locator('.message-attachments').boundingBox())!;
  const bubble = (await withText.locator('.user-bubble').boundingBox())!;
  expect(above.y + above.height).toBeLessThanOrEqual(bubble.y);
  // Right edges line up, as everything of a question does.
  expect(Math.abs(above.x + above.width - (bubble.x + bubble.width))).toBeLessThanOrEqual(1);
  await expect(withText.locator('.user-bubble')).toHaveText('看看这两个文件');
  const alone = users.nth(4);
  await expect(alone.locator('.attachment-tile')).toHaveCount(1);
  await expect(alone.locator('.user-bubble')).toHaveCount(0);
});

test('many pictures wrap into rows of small tiles at the right, and a click opens one whole', async ({
  page,
}) => {
  await page.goto('/test/fixtures/sent-attachments.html?pictures=9');
  const tiles = page.locator('.message-attachments .attachment-tile');
  await expect(tiles).toHaveCount(10);
  await expect(page.locator('.attachment-open')).toHaveCount(9);
  const row = (await page.locator('.message-attachments').boundingBox())!;
  // Rows rather than one long strip: nothing wider than the message, no sideways scrolling.
  expect(row.width).toBeLessThanOrEqual(600);
  expect(row.height).toBeGreaterThan(96 * 2);
  const last = (await tiles.last().boundingBox())!;
  expect(Math.abs(last.x + last.width - (row.x + row.width))).toBeLessThanOrEqual(1);
  // The file is not a picture: nothing to open.
  await expect(tiles.last()).not.toHaveRole('button');
  await page.getByRole('button', { name: /图1\.png/ }).click();
  const dialog = page.getByRole('dialog', { name: '图1.png' });
  await expect(dialog).toBeVisible();
  // The whole picture cannot be read in a browser; the preview stands in for it.
  await expect(dialog.locator('img')).toHaveAttribute('src', /^data:image\/png/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
