import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const folder = resolve(screenshots, '过程图片');
mkdirSync(folder, { recursive: true });

// A solid picture of its own colour, as a screenshot Claude took would be one of its own.
function png(width: number, height: number, [r, g, b]: number[]) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill([r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
const colours = [
  [217, 119, 87],
  [94, 129, 172],
  [120, 170, 110],
  [200, 170, 80],
  [150, 110, 170],
];
const pictures = colours.map((colour) => png(160, 100, colour));
const looked = (index: number) => [
  {
    type: 'tool.requested',
    toolId: `shot-${index}`,
    name: 'Read',
    input: JSON.stringify({ file_path: `/tmp/shot-${index}.png` }),
    target: 'Linux',
  },
  {
    type: 'tool.result',
    toolId: `shot-${index}`,
    status: 'completed',
    output: JSON.stringify([
      { type: 'text', text: 'Read image' },
      { type: 'image', source: { type: 'base64', data: pictures[index], media_type: 'image/png' } },
    ]),
    exitCode: null,
  },
];

async function open(page: Page, finished: boolean) {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '过程图片',
    autoTitle: false,
    projectPath: 'D:\\工作\\图片',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: finished ? null : { id: runId, status: 'running', connectionId },
  };
  const payloads = [
    { type: 'message.user', messageId: randomUUID(), text: '改一下界面并截图', scenario: 'chat' },
    { type: 'run.status', status: 'running', connectionId },
    ...(finished
      ? [
          ...pictures.flatMap((_, index) => looked(index)),
          { type: 'text.delta', messageId: randomUUID(), text: '改好了，截图都在上面。' },
          { type: 'run.status', status: 'completed', connectionId },
        ]
      : []),
  ];
  let sequence = 0;
  const events = payloads.map((payload) => ({
    sessionId: session.id,
    runId,
    sequence: ++sequence,
    createdAt: now,
    payload,
  }));
  let send: (value: unknown) => void = () => {};
  await page.routeWebSocket('ws://127.0.0.1:18898/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
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
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18898/ws');
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
  await expect(page.locator('.message.user')).toHaveCount(1);
  // Later events of the run, as the service sends them while it goes on.
  const push = (payload: unknown) =>
    send({
      type: 'session.event',
      event: { sessionId: session.id, runId, sequence: ++sequence, createdAt: now, payload },
    });
  return { push, connectionId };
}

// A line keeps the height it has without its pictures.
async function keepsItsHeight(summary: import('@playwright/test').Locator) {
  const strip = summary.locator('.picture-strip');
  const height = (await summary.boundingBox())!.height;
  await strip.evaluate((node: HTMLElement) => (node.style.display = 'none'));
  const without = (await summary.boundingBox())!.height;
  await strip.evaluate((node: HTMLElement) => (node.style.display = ''));
  expect(height).toBe(without);
}

test('pictures arrive on the line of the step that took them while the run goes on', async ({
  page,
}) => {
  const { push, connectionId } = await open(page, false);
  const step = page.locator('details.work').last();
  for (const [index, payload] of [...looked(0), ...looked(1)].entries()) {
    push(payload);
    if (index === 1) await expect(step.locator('.picture-thumb')).toHaveCount(1);
  }
  // The step's line stays folded and one line high, and carries both thumbnails.
  await expect(step).not.toHaveAttribute('open');
  await expect(step.locator('> summary .picture-thumb')).toHaveCount(2);
  await keepsItsHeight(step.locator('> summary'));
  // Only a picture shown for the first time fades in.
  await expect(step.locator('.picture-thumb.fresh')).toHaveCount(2);
  await page.locator('.conversation').screenshot({ path: resolve(folder, '运行中.png') });

  // A picture opened from the step stays open when the run finishes and folds its steps into the turn's line.
  await step.locator('> summary .picture-thumb').last().click();
  const dialog = page.locator('dialog:has(.picture-view)');
  await expect(dialog.locator('h2')).toHaveText('图片 2 / 2');
  push({ type: 'text.delta', messageId: randomUUID(), text: '好了。' });
  push({ type: 'run.status', status: 'completed', connectionId });
  await expect(page.locator('details.turn-process')).toHaveCount(1);
  await expect(page.locator('details.work')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2')).toHaveText('图片 2 / 2');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.locator('h2')).toHaveText('图片 1 / 2');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The turn's line carries the same pictures, which do not fade in again.
  const strip = page.locator('details.turn-process > summary .picture-strip');
  await expect(strip.locator('.picture-thumb')).toHaveCount(2);
  await expect(strip.locator('.picture-thumb.fresh')).toHaveCount(0);
});

test('a finished turn keeps its pictures on its one folded line: latest three, the rest counted, opened in turn', async ({
  page,
}) => {
  await open(page, true);
  const process = page.locator('details.turn-process');
  await expect(process).not.toHaveAttribute('open');
  const strip = process.locator('> summary .picture-strip');
  await expect(strip.locator('.picture-thumb')).toHaveCount(3);
  await expect(strip.locator('.picture-more')).toHaveText('+2');
  await expect(strip).toHaveAttribute('aria-label', '本轮的图片：5 张图片');
  await keepsItsHeight(process.locator('> summary'));

  // Under the pointer a picture shows larger beside the line, which does not move.
  const before = (await process.locator('> summary').boundingBox())!;
  await strip.locator('.picture-thumb').last().hover();
  const peek = page.locator('.picture-peek');
  await expect(peek).toBeVisible();
  const box = (await peek.boundingBox())!;
  // As wide as the picture (160 and the frame), centred on its thumbnail.
  expect(box.width).toBe(168);
  const thumb = (await strip.locator('.picture-thumb').last().boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (thumb.x + thumb.width / 2))).toBeLessThanOrEqual(1);
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width - 8);
  expect((await process.locator('> summary').boundingBox())!.y).toBe(before.y);
  await page.screenshot({ path: resolve(folder, '悬停预览.png') });
  await page.mouse.move(0, 0);
  await expect(peek).toHaveCount(0);

  // A click opens them one at a time, and does not unfold the line.
  await strip.locator('.picture-thumb').first().click();
  const dialog = page.locator('dialog:has(.picture-view)');
  await expect(dialog.locator('h2')).toHaveText('图片 3 / 5');
  await page.keyboard.press('ArrowRight');
  await expect(dialog.locator('h2')).toHaveText('图片 4 / 5');
  await dialog.getByRole('button', { name: '下一张' }).click();
  await expect(dialog.locator('h2')).toHaveText('图片 5 / 5');
  await expect(dialog.getByRole('button', { name: '下一张' })).toBeDisabled();
  await page.screenshot({ path: resolve(folder, '查看器.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(process).not.toHaveAttribute('open');
  await strip.locator('.picture-more').click();
  await expect(dialog.locator('h2')).toHaveText('图片 1 / 5');
  await expect(dialog.getByRole('button', { name: '上一张' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.locator('.conversation').screenshot({ path: resolve(folder, '完成后.png') });

  // Unfolded, the turn's line lets its steps carry the pictures instead of showing them twice.
  await process.locator('> summary').click();
  await expect(process).toHaveAttribute('open');
  await expect(strip).toHaveCount(0);
  await expect(process.locator('details.work > summary .picture-thumb')).toHaveCount(3);
  // Pictures already shown on the turn's line do not fade in again on the step's.
  await expect(process.locator('details.work > summary .picture-thumb.fresh')).toHaveCount(0);
});
