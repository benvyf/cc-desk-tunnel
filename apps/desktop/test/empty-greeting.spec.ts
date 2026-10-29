import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

async function open(
  page: Page,
  options: { hold?: boolean; earlier?: boolean; active?: boolean; fail?: boolean } = {},
) {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: 'Greeting review',
    autoTitle: false,
    projectPath: 'D:\\greeting',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: options.active ? { id: randomUUID(), status: 'running', connectionId } : null,
  };
  const otherSession: Session = { ...session, id: randomUUID(), title: 'Other conversation' };
  let snapshot = () => {};
  let output = () => {};
  let fail = !!options.fail;
  await page.routeWebSocket('ws://127.0.0.1:18896/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    output = () =>
      send({
        type: 'session.event',
        event: {
          sessionId: session.id,
          runId: randomUUID(),
          sequence: 1,
          createdAt: now,
          payload: {
            type: 'message.user',
            messageId: randomUUID(),
            text: 'First question',
            scenario: 'chat',
          },
        },
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
          sessions: options.fail ? [session, otherSession] : [session],
        });
      if (message.type === 'session.subscribe') {
        if (fail) {
          fail = false;
          return send({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            message: 'Greeting history failed',
            code: 'history_unavailable',
          });
        }
        snapshot = () => {
          send({
            type: 'session.snapshot',
            requestId: message.requestId,
            session: message.sessionId === session.id ? session : otherSession,
            mode: 'replace',
            firstSequence: 0,
            lastSequence: 0,
            hasEarlier: !!options.earlier,
            events: [],
          });
          send({ type: 'response', requestId: message.requestId, ok: true });
        };
        if (!options.hold) snapshot();
        return;
      }
      if (message.type === 'session.history')
        return send({
          type: 'response',
          requestId: message.requestId,
          ok: false,
          message: 'History unavailable',
          code: 'history_unavailable',
        });
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18896/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-greeting-credential-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.transcript')).toBeAttached();
  return { snapshot: () => snapshot(), output: () => output() };
}

test('greeting waits for history and disappears with the first question', async ({ page }) => {
  const { snapshot, output } = await open(page, { hold: true });
  await expect(page.locator('.history-status')).toContainText('同步会话');
  await expect(page.locator('.empty-greeting')).toHaveCount(0);
  snapshot();
  await expect(page.locator('.empty-greeting')).toHaveText('You’re here!');
  await expect(page.locator('.transcript')).toHaveClass('transcript is-empty');
  output();
  await expect(page.locator('.message.user')).toContainText('First question');
  await expect(page.locator('.empty-greeting')).toHaveCount(0);
  await expect(page.locator('.transcript')).not.toHaveClass(/is-empty/);
});

test('partial history and a history error never present a new-session greeting', async ({
  page,
}) => {
  await open(page, { earlier: true });
  await page.screenshot({
    path: resolve(screenshots, 'greeting-before-partial.png'),
    animations: 'disabled',
  });
  await expect(page.locator('.empty-greeting')).toHaveCount(0);
  await page.locator('.history-load').click();
  await expect(page.locator('.history-status[role="alert"]')).toBeVisible();
  await expect(page.locator('.empty-greeting')).toHaveCount(0);
});

test('an active run without loaded turns never presents a new-session greeting', async ({
  page,
}) => {
  await open(page, { active: true });
  await expect(page.locator('.empty-greeting')).toHaveCount(0);
});

test('a failed initial subscription does not claim the conversation is empty and a retry recovers', async ({
  page,
}) => {
  await open(page, { fail: true });
  await expect(page.getByText('Greeting history failed', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.history-status[role="status"]')).toHaveCount(0);
  await expect(page.locator('.empty-greeting')).toHaveCount(0);
  await page
    .locator('.session-row')
    .filter({ hasText: 'Other conversation' })
    .locator('.session-select')
    .click();
  await expect(page.locator('.empty-greeting')).toBeVisible();
  await page
    .locator('.session-row')
    .filter({ hasText: 'Greeting review' })
    .locator('.session-select')
    .click();
  await expect(page.locator('.empty-greeting')).toBeVisible();
});

test('greeting stays inside the conversation when the draft grows and the sidebar changes width', async ({
  page,
}) => {
  await open(page);
  await page.setViewportSize({ width: 900, height: 560 });
  await page.locator('.sidebar-resize').press('End');
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill(Array.from({ length: 14 }, (_, i) => 'Draft line ' + i).join('\n'));
  await expect(input).toHaveValue(/Draft line 13/);
  await page.screenshot({
    path: resolve(screenshots, 'greeting-large-draft.png'),
    animations: 'disabled',
  });
  const layout = await page.locator('.empty-greeting h2').evaluate((heading) => {
    const text = heading.getBoundingClientRect();
    const parent = heading.closest('.conversation')!;
    const box = parent.getBoundingClientRect();
    return {
      top: text.top,
      bottom: text.bottom,
      boxTop: box.top,
      boxBottom: box.bottom,
      scroll: parent.scrollHeight,
      height: parent.clientHeight,
    };
  });
  expect(layout.top).toBeGreaterThanOrEqual(layout.boxTop);
  expect(layout.bottom).toBeLessThanOrEqual(layout.boxBottom);
  expect(layout.scroll).toBeLessThanOrEqual(layout.height + 1);
  await input.fill('');
  await page.locator('.sidebar-resize').press('Home');
  await expect(page.locator('.empty-greeting')).toBeInViewport();
});

test('greeting stays readable when its local font cannot load', async ({ page }) => {
  await page.route('**/newsreader-greeting.woff2', (route) => route.abort());
  await open(page);
  const heading = page.locator('.empty-greeting h2');
  await expect(heading).toHaveText('You’re here!');
  await expect(heading).toHaveAttribute('lang', 'en');
  await expect(page.locator('.empty-greeting svg')).toHaveAttribute('aria-hidden', 'true');
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.fonts.check('40px "CC Greeting"', 'You’re here!')),
  ).toBe(false);
  const style = await heading.evaluate((element) => {
    const family = getComputedStyle(element).fontFamily;
    const font = Array.from(document.fonts).find((font) => font.family.includes('CC Greeting'));
    return { family, display: font?.display };
  });
  expect(style.family).toContain('Georgia');
  expect(style.display).toBe('swap');
  await page.setViewportSize({ width: 380, height: 560 });
  await page.screenshot({
    path: resolve(screenshots, 'greeting-font-fallback.png'),
    animations: 'disabled',
  });
  await expect(heading).toBeInViewport();
});

for (const theme of ['light', 'dark'] as const) {
  test(
    'greeting fits available space, interface font sizes and local fonts in ' + theme,
    async ({ page }) => {
      await page.addInitScript(
        (theme) => localStorage.setItem('proxy-prefs', JSON.stringify({ theme })),
        theme,
      );
      await open(page);
      const greeting = page.locator('.empty-greeting');
      await expect(greeting).toBeVisible();
      await page.evaluate(() => document.fonts.load('40px "CC Greeting"', 'You’re here!'));
      expect(
        await page.evaluate(() => document.fonts.check('40px "CC Greeting"', 'You’re here!')),
      ).toBe(true);
      for (const [width, height, size] of [
        [1280, 900, 14],
        [380, 560, 14],
        [320, 560, 20],
        [380, 360, 20],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(async (size) => {
          const path = '/src/prefs.ts';
          const { setPrefs } = await import(path);
          setPrefs((prefs: import('../src/prefs.ts').Prefs) => ({
            ...prefs,
            fontSizes: { ...prefs.fontSizes, interface: size },
          }));
        }, size);
        await page.screenshot({
          path: resolve(
            screenshots,
            'greeting-' + theme + '-' + width + '-' + height + '-' + size + '.png',
          ),
          animations: 'disabled',
        });
        const layout = await greeting.evaluate((element) => {
          const parent = element.closest('.conversation')!;
          const box = parent.getBoundingClientRect();
          const heading = element.querySelector('h2')!;
          const text = heading.getBoundingClientRect();
          const icon = element.querySelector('svg')!.getBoundingClientRect();
          return {
            box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
            text: { left: text.left, right: text.right, top: text.top, bottom: text.bottom },
            iconRight: icon.right,
            headingHeight: text.height,
            lineHeight: parseFloat(getComputedStyle(heading).lineHeight),
            scrollHeight: parent.scrollHeight,
            clientHeight: parent.clientHeight,
            letterSpacing: getComputedStyle(heading).letterSpacing,
          };
        });
        expect.soft(layout.text.left).toBeGreaterThanOrEqual(layout.box.left);
        expect.soft(layout.text.right).toBeLessThanOrEqual(layout.box.right);
        expect.soft(layout.text.top).toBeGreaterThanOrEqual(layout.box.top);
        expect.soft(layout.text.bottom).toBeLessThanOrEqual(layout.box.bottom);
        expect.soft(layout.iconRight).toBeLessThanOrEqual(layout.text.left);
        expect.soft(layout.headingHeight).toBeLessThanOrEqual(layout.lineHeight + 1);
        expect.soft(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1);
        expect.soft(['normal', '0px']).toContain(layout.letterSpacing);
      }
    },
  );
}
