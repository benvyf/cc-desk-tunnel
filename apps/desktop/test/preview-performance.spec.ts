import { test, expect } from '@playwright/test';

test('native previews ignore unrelated transcript mutations but still hide under a menu', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '网站错误', exact: true }).click();
  await expect(page.locator('.preview-native')).toBeVisible();
  const result = await page.evaluate(async () => {
    const native = document.querySelector('.preview-native')!;
    const original = native.getBoundingClientRect.bind(native);
    let reads = 0;
    native.getBoundingClientRect = () => {
      reads++;
      return original();
    };
    const wait = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    const transcript = document.createElement('div');
    transcript.className = 'conversation';
    document.body.append(transcript);
    const text = document.createElement('p');
    text.className = 'message-content';
    transcript.append(text);
    await wait();
    reads = 0;
    for (let i = 0; i < 20; i++) {
      text.textContent = `Streaming fragment ${i}`;
      text.classList.toggle('streaming');
      await wait();
    }
    const streamReads = reads;
    const calls: any[] = [];
    const api = window.desktop!.preview,
      bounds = api.bounds;
    api.bounds = async (input) => {
      calls.push(input);
      return bounds(input);
    };
    const box = native.getBoundingClientRect(),
      menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    Object.assign(menu.style, {
      position: 'fixed',
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: '100px',
      height: '100px',
    });
    transcript.append(menu);
    await wait();
    const hidden = calls.some((call) => call.bounds === null);
    menu.remove();
    await wait();
    const restored = calls.some((call) => call.bounds !== null);
    // Existing content can become a popup without being inserted again.
    calls.length = 0;
    transcript.append(menu);
    menu.removeAttribute('role');
    await wait();
    calls.length = 0;
    menu.setAttribute('role', 'dialog');
    await wait();
    const roleHidden = calls.some((call) => call.bounds === null);
    calls.length = 0;
    menu.removeAttribute('role');
    await wait();
    const roleRestored = calls.some((call) => call.bounds !== null);
    // Removing an outer wrapper must also release its descendant overlay.
    const wrapper = document.createElement('div');
    wrapper.append(menu);
    menu.setAttribute('role', 'alertdialog');
    calls.length = 0;
    transcript.append(wrapper);
    await wait();
    const wrapperHidden = calls.some((call) => call.bounds === null);
    calls.length = 0;
    wrapper.remove();
    await wait();
    const wrapperRestored = calls.some((call) => call.bounds !== null);
    // Class-based popups must restore the preview even after their marker is removed in place.
    menu.removeAttribute('role');
    menu.className = 'menu';
    calls.length = 0;
    transcript.append(menu);
    await wait();
    const classHidden = calls.some((call) => call.bounds === null);
    calls.length = 0;
    menu.className = '';
    await wait();
    const classRestored = calls.some((call) => call.bounds !== null);
    transcript.remove();
    native.getBoundingClientRect = original;
    api.bounds = bounds;
    return {
      streamReads,
      hidden,
      restored,
      roleHidden,
      roleRestored,
      wrapperHidden,
      wrapperRestored,
      classHidden,
      classRestored,
    };
  });
  console.log(
    'native preview geometry reads for20 unrelated transcript updates',
    result.streamReads,
  );
  expect(result.hidden).toBe(true);
  expect(result.restored).toBe(true);
  expect(result.roleHidden).toBe(true);
  expect(result.roleRestored).toBe(true);
  expect(result.wrapperHidden).toBe(true);
  expect(result.wrapperRestored).toBe(true);
  expect(result.classHidden).toBe(true);
  expect(result.classRestored).toBe(true);
  expect(result.streamReads).toBe(0);
});

test('ten seconds of reading scroll keeps the workspace still and bounds local writes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    (window as any).readingWrites = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('cc-preview-v1:')) (window as any).readingWrites++;
      return original.call(this, key, value);
    };
  });
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '长文本', exact: true }).click();
  await expect(page.locator('.preview-document')).toContainText('Reading paragraph 360');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) => key.startsWith('cc-preview-v1:') && JSON.parse(value).reading,
        ),
      ),
    )
    .toBe(true);
  const before = await page.evaluate(() => ({
    ...(window as any).fixturePreview.counts(),
    writes: (window as any).readingWrites,
  }));
  await page.locator('.preview-document').evaluate(async (element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
    for (let step = 1; step <= 100; step++) {
      element.scrollTop = step * 10;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const [, raw] = Object.entries(localStorage).find(([key]) =>
          key.startsWith('cc-preview-v1:'),
        )!;
        const layout = JSON.parse(raw);
        return Object.values(layout.reading.sessions.session)[0] as { top: number };
      }),
    )
    .toMatchObject({ top: 1000 });
  const after = await page.evaluate(() => ({
    ...(window as any).fixturePreview.counts(),
    writes: (window as any).readingWrites,
  }));
  expect(after.renders).toBe(before.renders);
  expect(after.reads).toBe(before.reads);
  expect(after.watchCalls).toBe(before.watchCalls);
  expect(after.listenerAdds).toBe(before.listenerAdds);
  expect(after.nativeShows).toBe(before.nativeShows);
  expect(after.writes - before.writes).toBeGreaterThan(0);
  expect(after.writes - before.writes).toBeLessThanOrEqual(7);
  console.log('reading-scroll', JSON.stringify({ before, after }));
});
