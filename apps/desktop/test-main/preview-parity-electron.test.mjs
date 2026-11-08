import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'vite';
import { _electron, expect } from '@playwright/test';
import { utils, write } from 'xlsx';

test(
  'built spreadsheet worker runs from file URLs under the desktop CSP without Node integration',
  {
    skip: !process.env.CC_PREVIEW_PARITY_ELECTRON,
    timeout: 90000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-preview-parity-'));
    let app;
    try {
      await build({
        configFile: resolve('apps/desktop/vite.config.ts'),
        logLevel: 'error',
        build: {
          outDir: join(root, 'dist'),
          emptyOutDir: true,
          rollupOptions: { input: resolve('apps/desktop/test/fixtures/spreadsheet-preview.html') },
        },
      });
      const book = utils.book_new();
      utils.book_append_sheet(
        book,
        utils.aoa_to_sheet([
          ['编号', '金额'],
          ['00123', 42],
        ]),
        '收入',
      );
      const fixtures = { xlsx: write(book, { type: 'base64', bookType: 'xlsx' }) };
      const preload = join(root, 'preload.cjs');
      await writeFile(
        preload,
        `require('electron').contextBridge.exposeInMainWorld('spreadsheetFixtures',${JSON.stringify(fixtures)});`,
      );
      const html = join(root, 'dist/test/fixtures/spreadsheet-preview.html');
      const csp = (await readFile('apps/desktop/index.html', 'utf8')).match(
        /<meta http-equiv="Content-Security-Policy"[^>]+>/,
      )[0];
      await writeFile(html, (await readFile(html, 'utf8')).replace('<head>', '<head>' + csp));
      const entry = join(root, 'main.cjs');
      await writeFile(
        entry,
        `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},nodeIntegration:false,contextIsolation:true,sandbox:true}});win.loadFile(${JSON.stringify(html)});});`,
      );
      app = await _electron.launch({
        executablePath: process.env.CC_PREVIEW_PARITY_ELECTRON,
        args: [entry],
      });
      const page = await app.firstWindow();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.getByRole('button', { name: '打开 xlsx', exact: true }).click();
      await expect(
        page
          .getByRole('table', { name: '工作表 收入' })
          .getByRole('cell', { name: '00123', exact: true }),
      ).toBeVisible();
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      assert.deepEqual(errors, []);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
