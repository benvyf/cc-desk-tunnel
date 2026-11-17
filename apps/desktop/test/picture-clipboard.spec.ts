import { test, expect, _electron } from '@playwright/test';
import { resolve } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

// A tiny PNG of the given size.
function png(width: number, height: number) {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 180)]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The window may not use the clipboard itself (every permission is refused); a picture from the viewer goes through
// the main process, as text does. This writes the computer's clipboard, and puts back what it held.
test('Electron copies a picture from the viewer to the clipboard through its main process', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop test');
  test.slow();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const application = await _electron.launch({
    args: [
      resolve('apps/desktop'),
      `--user-data-dir=${resolve('.local/ui-test/profile-clipboard')}`,
    ],
    env,
  });
  // The clipboard of Electron 44 is asynchronous and holds ClipboardItems.
  const pictureSize = () =>
    application.evaluate(async ({ clipboard, nativeImage }) => {
      const item = (await clipboard.read()).find((entry) => entry.types.includes('image/png'));
      if (!item) return null;
      const blob = await item.getType('image/png');
      return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).getSize();
    });
  const saved = await application.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read();
    const picture = items.find((entry) => entry.types.includes('image/png'));
    return {
      text: await clipboard.readText(),
      image: picture
        ? Buffer.from(await (await picture.getType('image/png')).arrayBuffer()).toString('base64')
        : null,
    };
  });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => !!window.desktop?.copyImage);
    await page.evaluate(
      (bytes) => window.desktop!.copyImage!(new Uint8Array(bytes)),
      [...png(7, 5)],
    );
    expect(await pictureSize()).toEqual({ width: 7, height: 5 });
    // Bytes that are no picture, or no bytes at all, are refused and leave the clipboard as it was.
    for (const bad of ['[1, 2, 3]', '"text"']) {
      const refused = await page.evaluate(async (value) => {
        try {
          const parsed = JSON.parse(value);
          await window.desktop!.copyImage!(
            (Array.isArray(parsed) ? new Uint8Array(parsed) : parsed) as Uint8Array,
          );
          return false;
        } catch {
          return true;
        }
      }, bad);
      expect(refused).toBe(true);
    }
    expect(await pictureSize()).toEqual({ width: 7, height: 5 });
  } finally {
    await application.evaluate(async ({ clipboard, ClipboardItem }, previous) => {
      if (previous.image)
        await clipboard.write([
          new ClipboardItem({
            'image/png': new Blob([Buffer.from(previous.image, 'base64')], { type: 'image/png' }),
          }),
        ]);
      else await clipboard.writeText(previous.text);
    }, saved);
    await application.close();
  }
});
