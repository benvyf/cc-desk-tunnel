import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';

// Rasterize the supplied vector artwork; no font rendering or new interpretation of the logo is involved.
const root = fileURLToPath(new URL('..', import.meta.url));
const assets = join(root, 'apps/desktop/brand');
const electron = join(root, 'apps/desktop/electron');
mkdirSync(electron, { recursive: true });
const read = (name) => readFileSync(join(assets, name), 'utf8');
const paths = read('s3-mark-mono-ink.svg')
  .match(/<path\b[^>]*\/>/g)
  .join('');
const coloured = read('s3-mark-on-clay.svg')
  .match(/<path\b[^>]*\/>/g)
  .join('');
const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  async function render(source, size, file) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}img{display:block;width:100%;height:100%}</style><img src="data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}">`,
    );
    await page.locator('img').evaluate((image) => image.decode());
    await page.screenshot({ path: join(electron, file), omitBackground: true });
  }
  await render(read('s3-icon-clay.svg'), 1024, 'icon.png');
  for (const size of [16, 32]) {
    const height = size * 0.875;
    const scale = height / 237.21;
    const body = `<rect width="${size}" height="${size}" rx="${size * 0.225}" fill="#D97757"/><g transform="translate(${(size - 116 * scale) / 2} ${(size - height) / 2}) scale(${scale})">${coloured}</g>`;
    await render(svg(size, body), size, size === 16 ? 'favicon.png' : 'tray.png');
  }
  for (const size of [18, 36]) {
    const scale = (size - (2 * size) / 18) / 237.21;
    await render(
      svg(
        size,
        `<g transform="translate(${(size - 116 * scale) / 2} ${size / 18}) scale(${scale})">${paths}</g>`,
      ),
      size,
      size === 18 ? 'trayTemplate.png' : 'trayTemplate@2x.png',
    );
  }
} finally {
  await browser.close();
}
console.log('CC SPACE application, tray, template and favicon PNGs generated from supplied SVGs.');
