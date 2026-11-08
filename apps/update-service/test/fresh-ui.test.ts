import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';

test(
  'fresh-node form copies one command, expires it, and clears it on node changes/logout',
  { skip: process.env.CC_UPDATE_UI_TEST !== '1', timeout: 30000 },
  async (t) => {
    const browser = await chromium.launch({
      headless: true,
      channel:
        process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.install();
    const web = new URL('../web/', import.meta.url);
    await context.route('https://fixture.example.invalid/**', async (route) => {
      const file = new URL(route.request().url()).pathname.split('/').pop() || 'index.html';
      if (file === 'app.js') {
        await route.fulfill({
          contentType: 'text/javascript',
          body: `
          import {setupFreshNodes} from './fresh-nodes.js';
          document.getElementById('dashboard').hidden=false;
          document.getElementById('updates-panel').hidden=false;
          document.getElementById('login-panel').hidden=true;
          window.fixture=setupFreshNodes({
            request: async(path,options)=>({nodeId:JSON.parse(options.body).nodeId,build:3,expiresAt:new Date(Date.now()+600000).toISOString(),command:'sudo python3 -c synthetic-one-time-command'}),
            action: fn=>fn().catch(e=>document.getElementById('notice').textContent=e.message),
            notice: text=>document.getElementById('notice').textContent=text,
            date: value=>value
          });
        `,
        });
      } else if (['index.html', 'fresh-nodes.js', 'style.css'].includes(file)) {
        await route.fulfill({
          contentType: file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/html',
          body: readFileSync(new URL(file, web)),
        });
      } else await route.abort();
    });
    await page.goto('https://fixture.example.invalid/cc-updates/admin/');
    await page.locator('#fresh-node').fill('ubuntu-cc-2');
    await page.locator('#fresh-form button').click();
    await expect(page.locator('#fresh-command')).toHaveValue(
      'sudo python3 -c synthetic-one-time-command',
    );
    await page.locator('#fresh-copy').click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      'sudo python3 -c synthetic-one-time-command',
    );
    await page.clock.fastForward(601000);
    await expect(page.locator('#fresh-command')).toHaveValue('');
    await expect(page.locator('#fresh-expiry')).toContainText('已过期');
    await page.locator('#fresh-form button').click();
    await page.locator('#fresh-node').fill('ubuntu-cc-3');
    await expect(page.locator('#fresh-result')).toBeHidden();
    await page.locator('#fresh-form button').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() =>
      (window as unknown as { fixture: { clear(): void } }).fixture.clear(),
    );
    await expect(page.locator('#fresh-command')).toHaveValue('');
    await expect(page.locator('#fresh-result')).toBeHidden();
    assert.deepEqual(errors, []);
  },
);
