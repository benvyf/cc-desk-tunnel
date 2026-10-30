import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from '@playwright/test';
import { createPackageWithOptions } from '@electron/asar';
import { stagePreviewOffice } from '../../../scripts/package-preview-office.mjs';

test(
  'packaged ASAR loads physical Office workers and engine and converts in real Electron',
  {
    skip: process.platform !== 'win32' || !process.env.CC_OFFICE_INTEGRATION,
    timeout: 120_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'cc-office-packaged-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = join(root, 'app');
    await mkdir(join(app, 'electron'), { recursive: true });
    stagePreviewOffice(resolve('.'), app);
    for (const file of ['preview-office.cjs', 'file-links.cjs'])
      await cp(resolve('apps/desktop/electron', file), join(app, 'electron', file));
    await writeFile(
      join(app, 'package.json'),
      JSON.stringify({ name: 'cc-office-fixture', version: '1.0.0', main: 'entry.cjs' }),
    );
    await writeFile(
      join(app, 'entry.cjs'),
      `const {app,BrowserWindow}=require('electron');global.fixtureOffice=require('./electron/preview-office.cjs').createPreviewOffice;app.setPath('userData',${JSON.stringify(join(root, 'profile'))});app.whenReady().then(()=>{const window=new BrowserWindow({show:false});window.loadURL('data:text/html,<h1>Office fixture</h1>');});`,
    );
    const archive = join(root, 'app.asar');
    await createPackageWithOptions(app, archive, { unpackDir: 'node_modules' });
    const electron = await _electron.launch({
      timeout: 30000,
      executablePath: resolve('node_modules/electron/dist/electron.exe'),
      args: [archive],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'),
      ),
    });
    try {
      const result = await electron.evaluate(async ({ app }, input) => {
        const controller = globalThis.fixtureOffice();
        try {
          const result = await controller.render(input);
          return Buffer.from(result.data, 'base64').subarray(0, 5).toString();
        } finally {
          await controller.close();
        }
      }, resolve('apps/desktop/test-main/fixtures/office/sample.doc'));
      assert.equal(result, '%PDF-');
    } finally {
      await electron.close();
    }
  },
);
