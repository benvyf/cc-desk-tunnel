import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
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
// Three screenshots in the first step; in the second, a tall document page and one more screenshot.
const pictures = [
  png(320, 200, [217, 119, 87]),
  png(320, 200, [94, 129, 172]),
  png(320, 200, [120, 170, 110]),
  png(1400, 2000, [244, 244, 240]),
  png(320, 200, [150, 110, 170]),
];
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
const said = (text: string) => ({ type: 'text.delta', messageId: randomUUID(), text });

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
          ...looked(0),
          ...looked(1),
          ...looked(2),
          said('先看一下这几张。'),
          ...looked(3),
          ...looked(4),
          said('改好了，截图都在上面。'),
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
async function keepsItsHeight(summary: Locator) {
  const strip = summary.locator('.picture-strip');
  const height = (await summary.boundingBox())!.height;
  await strip.evaluate((node: HTMLElement) => (node.style.display = 'none'));
  const without = (await summary.boundingBox())!.height;
  await strip.evaluate((node: HTMLElement) => (node.style.display = ''));
  expect(height).toBe(without);
}
const viewer = (page: Page) => page.locator('dialog.picture-viewer');

test('while a run goes on, its latest pictures stand above "正在执行…", and the viewer they open outlives the run', async ({
  page,
}) => {
  const { push, connectionId } = await open(page, false);
  for (const payload of [...looked(0), ...looked(1)]) push(payload);
  const live = page.locator('.live-pictures');
  await expect(live.locator('.picture-thumb')).toHaveCount(2);
  // Seen without unfolding anything: 64px high, in one line 72px high, above the run's status.
  const status = page.getByText('正在执行…');
  expect((await live.boundingBox())!.height).toBe(72);
  expect((await live.boundingBox())!.y).toBeLessThan((await status.boundingBox())!.y);
  expect((await live.locator('.picture-thumb').first().boundingBox())!.height).toBe(64);
  // The step's folded line carries its own small thumbnails, a line high.
  const step = page.locator('details.work').last();
  await expect(step).not.toHaveAttribute('open');
  await expect(step.locator('> summary .picture-thumb')).toHaveCount(2);
  await keepsItsHeight(step.locator('> summary'));
  // Thumbnails show small copies, not the pictures themselves.
  await expect
    .poll(() => live.locator('img').first().getAttribute('src'))
    .toMatch(/^data:image\/webp;base64,/);
  expect((await live.locator('img').first().getAttribute('src'))!.length).toBeLessThan(
    pictures[0].length,
  );
  await page.locator('.conversation').screenshot({ path: resolve(folder, '运行中.png') });

  // Opened from the live line, the viewer takes up the pictures the run goes on taking, without leaving its own.
  await live.locator('.picture-thumb').last().click();
  const dialog = viewer(page);
  await expect(dialog.locator('.viewer-count')).toHaveText('2 / 2 · 第 1 步');
  for (const payload of looked(2)) push(payload);
  await expect(dialog.getByRole('button', { name: '有 1 张新图' })).toBeVisible();
  await expect(dialog.locator('.viewer-count')).toHaveText('2 / 3 · 第 1 步');
  await expect(dialog.locator('.viewer-film-thumb')).toHaveCount(3);
  await dialog.getByRole('button', { name: '有 1 张新图' }).click();
  await expect(dialog.locator('.viewer-count')).toHaveText('3 / 3 · 第 1 步');
  await expect(dialog.getByRole('button', { name: /张新图/ })).toHaveCount(0);
  // The run finishing folds its steps and takes the live line away; the viewer stays.
  push(said('好了。'));
  push({ type: 'run.status', status: 'completed', connectionId });
  await expect(page.locator('details.turn-process')).toHaveCount(1);
  await expect(live).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.locator('.viewer-count')).toHaveText('2 / 3 · 第 1 步');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('a finished turn names its pictures on its folded line, and its steps show them in a row when opened', async ({
  page,
}) => {
  await open(page, true);
  const process = page.locator('details.turn-process');
  await expect(process).not.toHaveAttribute('open');
  const summary = process.locator('> summary');
  await expect(summary).toContainText('5 张图片');
  const strip = summary.locator('.picture-strip');
  await expect(strip.locator('.picture-thumb')).toHaveCount(3);
  // The latest three, then how many more.
  await expect(strip.locator('.picture-more')).toHaveText('+2');
  expect((await strip.locator('.picture-more').boundingBox())!.x).toBeGreaterThan(
    (await strip.locator('.picture-thumb').last().boundingBox())!.x,
  );
  await expect(strip).toHaveAttribute('aria-label', '本轮的图片：5 张图片');
  await keepsItsHeight(summary);
  // Under the pointer a picture shows larger beside the line, which does not move.
  const before = (await summary.boundingBox())!;
  await strip.locator('.picture-thumb').last().hover();
  await expect(page.locator('.picture-peek')).toBeVisible();
  expect((await summary.boundingBox())!.y).toBe(before.y);
  await page.mouse.move(0, 0);
  await page.locator('.conversation').screenshot({ path: resolve(folder, '完成后.png') });

  // Opened, the steps are named by their pictures, and an open step shows them in a 64px row under its line.
  await summary.click();
  await expect(process).toHaveAttribute('open');
  await expect(strip).toHaveCount(0);
  const steps = process.locator('details.work');
  await expect(steps).toHaveCount(2);
  await expect(steps.first().locator('> summary')).toContainText('查看了 3 张图片');
  await expect(steps.last().locator('> summary')).toContainText('查看了 2 张图片');
  await expect(steps.first().locator('> summary .picture-thumb')).toHaveCount(3);
  await steps.first().locator('> summary').click();
  const row = steps.first().locator('.picture-row').first();
  await expect(row.locator('.picture-thumb')).toHaveCount(3);
  expect((await row.boundingBox())!.height).toBe(64);
  expect((await row.locator('.picture-thumb').first().boundingBox())!.height).toBe(64);
  // The step's line, open, carries no thumbnails of its own: the row has them.
  await expect(steps.first().locator('> summary .picture-strip')).toHaveCount(0);
  // One stop of the Tab key; the arrows move within it.
  await row.locator('.picture-thumb').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(row.locator('.picture-thumb').nth(1)).toBeFocused();
  expect(await row.locator('.picture-thumb').nth(1).getAttribute('tabindex')).toBe('0');
  expect(await row.locator('.picture-thumb').first().getAttribute('tabindex')).toBe('-1');
  // A tool's output shows its picture in the same row, not a large one among its words.
  const tool = steps.first().locator('details.tool').first();
  await tool.locator('> summary').click();
  await expect(tool.locator('.tool-results .picture-row .picture-thumb')).toHaveCount(1);
  // Open, the call's line leaves its picture to the row.
  await expect(tool.locator('> summary .picture-strip')).toHaveCount(0);
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  const card = (await tool.locator('.tool-detail').boundingBox())!;
  const shot = (await tool.locator('.tool-results .picture-row .picture-thumb').boundingBox())!;
  expect(shot.y + shot.height).toBeLessThanOrEqual(card.y + card.height);
  await page.locator('.conversation').screenshot({ path: resolve(folder, '展开后.png') });

  // However many, one row: in a narrow window the ones that do not fit are counted in a last tile.
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(row.locator('.picture-row-more')).toBeVisible();
  const shown = await row.locator('.picture-thumb').count();
  await expect(row.locator('.picture-row-more')).toHaveText(`+${3 - shown}`);
  expect((await row.boundingBox())!.height).toBe(64);
});

test('in a narrow conversation a folded line keeps only its latest picture and counts the rest', async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 800 });
  await open(page, true);
  const width = await page.locator('.transcript').evaluate((node) => node.clientWidth);
  expect(width).toBeLessThanOrEqual(520);
  const strip = page.locator('details.turn-process > summary .picture-strip');
  await expect(strip.locator('.picture-thumb')).toHaveCount(1);
  await expect(strip.locator('.picture-more')).toHaveText('+4');
  // Widened, the line shows its latest three again.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(strip.locator('.picture-thumb')).toHaveCount(3);
  await expect(strip.locator('.picture-more')).toHaveText('+2');
});

test('the viewer pages the whole turn, reads a document page across its width, zooms, saves and copies', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, true);
  const strip = page.locator('details.turn-process > summary .picture-strip');
  const opener = strip.locator('.picture-thumb').first();
  await opener.click();
  const dialog = viewer(page);
  await expect(dialog).toBeVisible();
  // The whole window, dark; from the picture clicked, among all of the turn's.
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBe(page.viewportSize()!.width);
  expect(box.height).toBe(page.viewportSize()!.height);
  await expect(dialog.locator('.viewer-count')).toHaveText('3 / 5 · 第 1 步');
  const film = dialog.locator('.viewer-film-thumb');
  await expect(film).toHaveCount(5);
  await expect(film.nth(2)).toHaveAttribute('aria-current', 'true');
  // A gap where the pictures of another step begin.
  await expect(film.nth(3)).toHaveClass(/step-start/);
  await page.screenshot({ path: resolve(folder, '查看器.png') });

  // A tall document page opens across its width, from its top, and scrolls under the wheel.
  await page.keyboard.press('ArrowRight');
  await expect(dialog.locator('.viewer-count')).toHaveText('4 / 5 · 第 2 步');
  const image = dialog.locator('.viewer-stage > img');
  const stage = (await dialog.locator('.viewer-stage').boundingBox())!;
  // Across the stage, less the room of the side arrows, never past its own size.
  const across = `${Math.round(Math.min((stage.width - 112) / 1400, 1) * 100)}%`;
  await expect(dialog.locator('.viewer-percent')).toHaveText(across);
  await expect.poll(async () => (await image.boundingBox())!.y).toBe(stage.y);
  await page.screenshot({ path: resolve(folder, '文档页.png') });
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await image.boundingBox())!.y).toBeLessThan(stage.y - 100);
  // Dragged, it moves with the pointer.
  const dragged = (await image.boundingBox())!.y;
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2 + 120, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await image.boundingBox())!.y).toBeGreaterThan(dragged + 100);
  // The keys: 1 is the picture's own size, 0 the default, + and − zoom.
  await page.keyboard.press('1');
  await expect(dialog.locator('.viewer-percent')).toHaveText('100%');
  await page.keyboard.press('+');
  await expect(dialog.locator('.viewer-percent')).toHaveText('125%');
  await dialog.getByRole('button', { name: '缩小' }).click();
  await expect(dialog.locator('.viewer-percent')).toHaveText('100%');
  await page.keyboard.press('0');
  await expect(dialog.locator('.viewer-percent')).toHaveText(across);
  // A screenshot is seen whole.
  await page.keyboard.press('End');
  await expect(dialog.locator('.viewer-count')).toHaveText('5 / 5 · 第 2 步');
  await expect(dialog.getByRole('button', { name: '下一张' })).toBeDisabled();
  const whole = (await image.boundingBox())!;
  expect(whole.y).toBeGreaterThan(stage.y);
  expect(whole.y + whole.height).toBeLessThan(stage.y + stage.height);
  await page.keyboard.press('Home');
  await expect(dialog.locator('.viewer-count')).toHaveText('1 / 5 · 第 1 步');
  await film.nth(3).click();
  await expect(dialog.locator('.viewer-count')).toHaveText('4 / 5 · 第 2 步');

  // Saved under a name of its own, and copied as a picture.
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载图片' }).click();
  expect((await download).suggestedFilename()).toBe('图片-4.png');
  await dialog.getByRole('button', { name: '复制图片' }).click();
  await expect(dialog.locator('.viewer-note')).toHaveText('已复制图片');

  // Escape closes, and the thumbnail it was opened from has the focus again.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  // A click on the dark around the picture closes as well.
  await opener.click();
  await expect(dialog).toBeVisible();
  const around = (await dialog.locator('.viewer-stage').boundingBox())!;
  await page.mouse.click(around.x + 60, around.y + around.height - 30);
  await expect(dialog).toHaveCount(0);
});
