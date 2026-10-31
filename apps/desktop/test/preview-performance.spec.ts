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
