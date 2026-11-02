import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

type RecordedEvent = { kind: string; label?: string; data?: string };
const recording: { events: RecordedEvent[] } = JSON.parse(
  readFileSync(new URL('./fixtures/terminal-echo/linux295.json', import.meta.url), 'utf8'),
);
const events = recording.events;
const inputIndex = (label: string) =>
  events.findIndex((event) => event.kind === 'input' && event.label === label);
const checkpointIndex = (label: string) =>
  events.findIndex((event) => event.kind === 'checkpoint' && event.label === label);
const output = (start: number, end: number) =>
  events
    .slice(start, end)
    .filter((event) => event.kind === 'output')
    .map((event) => event.data)
    .join('');
const prefix = output(0, inputIndex('ascii-a'));
const echo = (label: string) => output(inputIndex(label) + 1, checkpointIndex(label));

async function emit(page: Page, data: string) {
  await page.evaluate((data) => {
    (window as any).terminalTest.emit({
      type: 'terminal.data',
      data,
      bytes: new TextEncoder().encode(data).length,
    });
  }, data);
}
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const api = (window as any).terminalTest;
    const terminal = api.terminalInstances.at(-1);
    const buffer = terminal.buffer.active;
    return {
      line: buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true),
      x: buffer.cursorX,
      y: buffer.cursorY,
      cols: terminal.cols,
      rows: terminal.rows,
      inputs: api.controls
        .filter((control: any) => control.type === 'terminal.input')
        .map((control: any) => control.data),
      opens: api.requests.filter((request: any) => request.type === 'terminal.open').length,
    };
  });
}
async function mount(page: Page, enabled = true) {
  await page.addInitScript(
    (enabled) =>
      localStorage.setItem('proxy-prefs', JSON.stringify({ terminalPredictiveEcho: enabled })),
    enabled,
  );
  await page.goto('/test/terminal-window.fixture.html?predictive=1');
  await expect(page.getByRole('tab')).toContainText('Linux · Claude Code');
  await expect.poll(async () => (await snapshot(page)).cols).toBe(100);
  await emit(page, prefix);
  await expect.poll(async () => (await snapshot(page)).line).toBe('❯\u00a0 ');
  await page.locator('.xterm-helper-textarea').focus();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  // Startup escape-sequence queries can produce existing xterm protocol replies.
  // Compare user input from this point, after the recorded startup has parsed.
  await page.evaluate(() => {
    (window as any).terminalTest.controls.length = 0;
  });
}
const spans = (page: Page) => page.locator('[data-predictive-echo] span');

for (const delay of [50, 150, 300]) {
  test(`real Linux ASCII echo converges at ${delay}ms without changing wire bytes or real buffer`, async ({
    page,
  }) => {
    await mount(page);
    for (const [label, character] of [
      ['ascii-a', 'a'],
      ['ascii-b', 'b'],
      ['ascii-c', 'c'],
    ]) {
      const before = await snapshot(page);
      const started = Date.now();
      await page.keyboard.press(character);
      await expect(spans(page)).toHaveText([character]);
      expect((await snapshot(page)).line).toBe(before.line);
      await page.waitForTimeout(Math.max(0, delay - (Date.now() - started)));
      await emit(page, echo(label));
      await expect(spans(page)).toHaveCount(0);
    }
    const result = await snapshot(page);
    expect(result.line).toBe('❯\u00a0abc ');
    expect(result.inputs).toEqual(['a', 'b', 'c']);
    expect(result.opens).toBe(1);
  });
}

test('queued characters converge when the real ANSI echo is split across escape sequences', async ({
  page,
}) => {
  await mount(page);
  await page.keyboard.type('abc');
  await expect(spans(page)).toHaveText(['a', 'b', 'c']);
  expect((await snapshot(page)).line).toBe('❯\u00a0 ');
  const data = echo('ascii-a') + echo('ascii-b') + echo('ascii-c');
  for (let offset = 0; offset < data.length; offset += 3)
    await emit(page, data.slice(offset, offset + 3));
  await expect(spans(page)).toHaveCount(0);
  expect((await snapshot(page)).line).toBe('❯\u00a0abc ');
  expect((await snapshot(page)).inputs).toEqual(['a', 'b', 'c']);
});

test('real reply history is allowed but menus, multiline editing and dialog focus are rejected', async ({
  page,
}) => {
  await mount(page);
  await emit(page, output(inputIndex('ascii-a'), checkpointIndex('submit-chinese')));
  await expect.poll(async () => (await snapshot(page)).line).toBe('❯\u00a0 ');
  await page.keyboard.press('z');
  await expect(spans(page)).toHaveText(['z']);
  await page.keyboard.press('Escape');
  await expect(spans(page)).toHaveCount(0);
  await emit(page, echo('slash-menu'));
  await page.keyboard.press('a');
  await expect(spans(page)).toHaveCount(0);
  await emit(page, echo('multiline'));
  await page.keyboard.press('b');
  await expect(spans(page)).toHaveCount(0);
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    dialog.showModal();
  });
  await expect(spans(page)).toHaveCount(0);
});

test('composition commits once through xterm and predicts supported Chinese text', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    textarea.value = '中文测试';
    textarea.setSelectionRange(4, 4);
    textarea.dispatchEvent(
      new CompositionEvent('compositionupdate', { bubbles: true, data: '中文测试' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    textarea.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: 'unreliable event data' }),
    );
  });
  await expect.poll(async () => (await snapshot(page)).inputs).toEqual(['中文测试']);
  await expect(spans(page)).toHaveText(['中', '文', '测', '试']);
  expect((await snapshot(page)).line).toBe('❯\u00a0 ');
  await emit(page, '\x1b[33;1H❯\u00a0中文测试\x1b[7m \x1b[27m\x1b[33;11H');
  await expect(spans(page)).toHaveCount(0);
  expect((await snapshot(page)).line).toBe('❯\u00a0中文测试 ');
});

test('Chromium native IME composition commits Chinese once with native listener timing', async ({
  page,
}) => {
  await mount(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.imeSetComposition', {
      text: '中文测试',
      selectionStart: 4,
      selectionEnd: 4,
    });
    await expect(spans(page)).toHaveCount(0);
    await cdp.send('Input.insertText', { text: '中文测试' });
    await expect.poll(async () => (await snapshot(page)).inputs).toEqual(['中文测试']);
    await expect(spans(page)).toHaveText(['中', '文', '测', '试']);
    expect((await snapshot(page)).line).toBe('❯\u00a0 ');
    await emit(page, '\x1b[33;1H❯\u00a0中文测试\x1b[7m \x1b[27m\x1b[33;11H');
    await expect(spans(page)).toHaveCount(0);
  } finally {
    await cdp.detach();
  }
});

test('pending backspace waits for deletion before predicting a retyped character', async ({
  page,
}) => {
  await mount(page);
  await page.keyboard.type('ab');
  await expect(spans(page)).toHaveText(['a', 'b']);
  await page.keyboard.press('Backspace');
  await expect(spans(page)).toHaveText(['a']);
  await emit(page, echo('ascii-a') + echo('ascii-b'));
  await expect.poll(async () => (await snapshot(page)).line).toBe('❯\u00a0ab ');
  await page.keyboard.press('c');
  await expect(spans(page)).toHaveCount(0);
  await emit(page, '\x1b[33;1H\x1b[2K❯\u00a0ac\x1b[7m \x1b[27m\x1b[33;5H');
  await expect.poll(async () => (await snapshot(page)).line).toBe('❯\u00a0ac ');
  await page.keyboard.press('d');
  await expect(spans(page)).toHaveText(['d']);
  expect((await snapshot(page)).inputs).toEqual(['a', 'b', '\x7f', 'c', 'd']);
});

test('re-enabling while input is in flight waits for a reliable new edit', async ({ page }) => {
  await mount(page);
  await page.keyboard.press('a');
  await expect(spans(page)).toHaveText(['a']);
  await page.evaluate(() => (window as any).terminalTest.setPrediction(false));
  await expect(page.locator('[data-predictive-echo]')).toHaveCount(0);
  await page.evaluate(() => (window as any).terminalTest.setPrediction(true));
  await expect(page.locator('[data-predictive-echo]')).toHaveCount(1);
  await page.keyboard.press('b');
  await expect(spans(page)).toHaveCount(0);
  await emit(page, echo('ascii-a'));
  await page.keyboard.press('c');
  await expect(spans(page)).toHaveCount(0);
  await emit(page, '\x1b[33;1H\x1b[2K❯\u00a0abc\x1b[7m \x1b[27m\x1b[33;6H');
  await expect.poll(async () => (await snapshot(page)).line).toBe('❯\u00a0abc ');
  await page.keyboard.press('d');
  await expect(spans(page)).toHaveText(['d']);
  expect((await snapshot(page)).inputs).toEqual(['a', 'b', 'c', 'd']);
  expect((await snapshot(page)).opens).toBe(1);
});

test('turning prediction off immediately clears overlays without restarting the terminal', async ({
  page,
}) => {
  await mount(page);
  await page.keyboard.press('a');
  await expect(spans(page)).toHaveCount(1);
  await page.evaluate(() => (window as any).terminalTest.setPrediction(false));
  await expect(page.locator('[data-predictive-echo]')).toHaveCount(0);
  await page.keyboard.press('b');
  expect((await snapshot(page)).inputs).toEqual(['a', 'b']);
  expect((await snapshot(page)).opens).toBe(1);
});

test('prediction failures still forward the original input exactly once', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).terminalTest.failPrediction());
  await page.keyboard.press('a');
  expect((await snapshot(page)).inputs).toEqual(['a']);
  await expect(page.locator('[data-predictive-echo]')).toHaveCount(0);
});

test('disabled prediction preserves normal terminal input and has no overlay', async ({ page }) => {
  await mount(page, false);
  await page.keyboard.type('abc');
  expect((await snapshot(page)).inputs).toEqual(['a', 'b', 'c']);
  await expect(page.locator('[data-predictive-echo]')).toHaveCount(0);
});

test('one-character clipboard paste is forwarded once without prediction', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'x');
    document
      .querySelector('.xterm-helper-textarea')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
  });
  expect((await snapshot(page)).inputs).toEqual(['\x1b[200~x\x1b[201~']);
  await expect(spans(page)).toHaveCount(0);
});

test('focus loss and disconnect clear pending display immediately', async ({ page }) => {
  await mount(page);
  await page.keyboard.press('a');
  await expect(spans(page)).toHaveCount(1);
  await page.evaluate(() => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
  });
  await expect(spans(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).terminalTest.update({ status: 'disconnected' }));
  await expect(page.getByRole('tab')).toContainText('连接中断');
  await expect(spans(page)).toHaveCount(0);
  // The recorded CLI enables focus reporting; losing focus sends its existing ESC[O reply.
  expect((await snapshot(page)).inputs).toEqual(['a', '\x1b[O']);
});

test('enabled and disabled prediction send identical keyboard, paste and focus frames', async ({
  browser,
}) => {
  const wires: string[][] = [];
  for (const enabled of [false, true]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await mount(page, enabled);
      await page.keyboard.type('ab');
      await page.keyboard.press('ArrowLeft');
      await page.evaluate(() => {
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
      });
      await page.locator('.xterm-helper-textarea').focus();
      await page.evaluate(() => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', 'x');
        document
          .querySelector('.xterm-helper-textarea')!
          .dispatchEvent(
            new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
          );
      });
      wires.push((await snapshot(page)).inputs);
    } finally {
      await context.close();
    }
  }
  expect(wires[1]).toEqual(wires[0]);
});

test('one hundred ordinary inputs predict within a frame before delayed remote echo', async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  await mount(page);
  await page.evaluate(() => {
    const metrics = { started: 0, times: [] as number[] };
    (window as any).predictionMetrics = metrics;
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'a') metrics.started = performance.now();
      },
      true,
    );
    const observer = new MutationObserver(() => {
      if (metrics.started && document.querySelector('[data-predictive-echo] span')) {
        metrics.times.push(performance.now() - metrics.started);
        metrics.started = 0;
      }
    });
    observer.observe(document.querySelector('.xterm-screen')!, { childList: true, subtree: true });
  });
  for (let sample = 0; sample < 100; sample++) {
    const count = (sample % 20) + 1;
    await page.keyboard.press('a');
    await expect(spans(page)).toHaveText(['a']);
    if (sample === 0)
      await page.screenshot({ path: testInfo.outputPath('prediction-before-echo.png') });
    await page.waitForTimeout(200);
    await emit(
      page,
      `\x1b[33;1H\x1b[2K❯\u00a0${'a'.repeat(count)}\x1b[7m \x1b[27m\x1b[33;${count + 3}H`,
    );
    await expect(spans(page)).toHaveCount(0);
    if (count === 20) {
      await page.keyboard.press('Enter');
      await emit(page, '\x1b[33;1H\x1b[2K❯\u00a0\x1b[7m \x1b[27m\x1b[33;3H');
      await expect.poll(async () => (await snapshot(page)).line).toBe('❯\u00a0 ');
    }
  }
  const times: number[] = await page.evaluate(() => (window as any).predictionMetrics.times);
  expect(times).toHaveLength(100);
  times.sort((a, b) => a - b);
  const metrics = {
    samples: times.length,
    p95DomMilliseconds: times[94],
    maximumDomMilliseconds: times[99],
    simulatedEchoMilliseconds: 200,
  };
  writeFileSync(testInfo.outputPath('latency.json'), JSON.stringify(metrics, null, 2));
  await testInfo.attach('prediction-latency', {
    body: JSON.stringify(metrics),
    contentType: 'application/json',
  });
  expect(metrics.p95DomMilliseconds).toBeLessThanOrEqual(16);
});
