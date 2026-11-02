import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/test/fixtures/model-controls.tsx';
    (await import(path)).mount();
  });
  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  return page.getByRole('slider', { name: '推理强度', exact: true });
}

test('effort follows sub-step pointer movement and commits only once after release', async ({
  page,
}) => {
  const slider = await fixture(page);
  await expect(page.getByRole('button', { name: '模型与推理强度', exact: true })).toContainText(
    'Opus 5.5',
  );
  await expect(page.getByRole('button', { name: '模型与推理强度', exact: true })).toHaveAttribute(
    'title',
    'Opus 5.5',
  );
  await expect(page.locator('.model-current')).toHaveText('Opus 5.5');
  const box = (await slider.boundingBox())!;
  const x = (position: number) => box.x + 15 + (box.width - 30) * position;
  await page.mouse.move(x(0.5), box.y + 15);
  await page.mouse.down();
  await page.mouse.move(x(0.54), box.y + 15);
  const first = await slider.inputValue();
  await page.mouse.move(x(0.58), box.y + 15);
  const second = await slider.inputValue();
  expect(Number(second)).toBeGreaterThan(Number(first));
  await expect(page.getByLabel('已提交')).toHaveText('[]');
  await page.mouse.move(x(0.82), box.y + 15);
  await expect(slider).toHaveAttribute('aria-valuetext', '极高');
  await page.mouse.up();
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh"]');
  await expect(slider).toBeDisabled();
  await expect(slider).toHaveAttribute('aria-valuetext', '极高');
  await expect(slider).toHaveValue('3');
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute('aria-valuetext', '极高');
});

test('keyboard steps between supported levels; cancelled drags and failed saves restore the committed value', async ({
  page,
}) => {
  const slider = await fixture(page);
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh"]');
  await expect(slider).toBeEnabled();
  await expect(slider).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh","low"]');
  await expect(slider).toBeEnabled();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + 15, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + 15);
  await slider.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuetext', '低');
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh","low"]');
  await page.getByRole('button', { name: '切换失败' }).click();
  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  await slider.focus();
  await page.keyboard.press('End');
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh","low","max"]');
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute('aria-valuetext', '低');
});

test('release outside the slider commits once, and closing during a drag cancels the preview', async ({
  page,
}) => {
  const slider = await fixture(page);
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, box.y - 60);
  await page.mouse.up();
  await expect(page.getByLabel('已提交')).toHaveText('["max"]');
  await expect(slider).toBeEnabled();
  await page.mouse.move(box.x + box.width - 15, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 15);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', '最高');
  await expect(page.getByLabel('已提交')).toHaveText('["max"]');
});

test('a catalog update cancels the old drag preview and keyboard navigation follows the new levels', async ({
  page,
}) => {
  const slider = await fixture(page);
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 15, box.y + 15);
  await expect(slider).toHaveAttribute('aria-valuetext', '最高');
  await page.evaluate(async () => {
    const path = '/test/fixtures/model-controls.tsx';
    (await import(path)).changeLevels(['low', 'medium', 'high']);
  });
  await expect(slider).toHaveAttribute('max', '2');
  await page.mouse.up();
  await expect(page.getByLabel('已提交')).toHaveText('[]');
  await expect(slider).toHaveAttribute('aria-valuetext', '高');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(page.getByLabel('已提交')).toHaveText('["low"]');
  await expect(slider).toBeEnabled();
  await expect(slider).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByLabel('已提交')).toHaveText('["low","high"]');
});

test('keyboard preview can be cancelled and the slider fits both themes with reduced motion', async ({
  page,
}) => {
  const slider = await fixture(page);
  await slider.focus();
  await page.keyboard.down('ArrowRight');
  await page.keyboard.press('Escape');
  await page.keyboard.up('ArrowRight');
  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', '高');
  await expect(page.getByLabel('已提交')).toHaveText('[]');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 640 });
  for (const theme of ['light', 'dark']) {
    await page
      .locator('html')
      .evaluate((node, theme) => node.setAttribute('data-theme', theme), theme);
    const menu = page.getByRole('dialog', { name: '模型与推理强度', exact: true });
    await expect(menu).toBeInViewport({ ratio: 1 });
    await menu.screenshot({ path: `.local/screenshots/effort-slider-${theme}-320.png` });
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await slider.focus();
  await page.keyboard.press('End');
  await expect(page.getByLabel('已提交')).toHaveText('["max"]');
  await expect(slider).toBeEnabled();
  await page.emulateMedia({ forcedColors: 'none' });
  const trigger = page.getByRole('button', { name: '模型与推理强度', exact: true });
  expect(
    await trigger.locator('span').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await trigger.screenshot({ path: '.local/screenshots/full-model-name-320.png' });
  await page.locator('.model-current').click();
  await expect(page.getByRole('option').filter({ hasText: 'Opus 5.5' })).toBeVisible();
});

// Effort as heat (style.css): each level colours the slider, its title and tick, and sets how fast a light
// sweeps along the fill. The top level burns: a flowing fill, a ring turning round the handle, embers, a breathing
// halo and a flowing gold title. Reduced motion keeps the colours only.
test('each effort level has its own colour and sweep; the top level burns; reduced motion stills them', async ({
  page,
}) => {
  const slider = await fixture(page);
  const view = page.locator('.effort-view');
  const heading = page.locator('.effort-heading strong');
  const tick = page.locator('.effort-ticks button.current');
  const running = () =>
    page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map((a) => ({
          name: (a as CSSAnimation).animationName,
          duration: Number(a.effect!.getTiming().duration),
        })),
    );
  const names = async () => new Set((await running()).map((a) => a.name));
  // The handle's halo is drawn on its pseudo-element, which the animation list does not include: watch the strip
  // just above the handle instead, which only the halo and the ring reach.
  const aboveHandleMoves = async () => {
    const box = (await slider.boundingBox())!;
    const at = Number(await slider.inputValue()) / Number(await slider.getAttribute('max'));
    const x = box.x + 15 + (box.width - 30) * at;
    const shots = new Set<string>();
    for (let i = 0; i < 4; i++) {
      shots.add(
        (
          await page.screenshot({ clip: { x: x - 20, y: box.y - 6, width: 40, height: 5 } })
        ).toString('base64'),
      );
      await page.waitForTimeout(300);
    }
    return shots.size > 1;
  };
  const pick = async (name: string, level: string) => {
    await page.locator('.effort-ticks').getByRole('button', { name, exact: true }).click();
    await expect(view).toHaveAttribute('data-effort', level);
    await expect(slider).toBeEnabled();
  };
  await expect(view).toHaveAttribute('data-effort', 'high');
  const colours: Record<string, string> = {};
  const sweeps: Record<string, number> = {};
  for (const [name, level] of [
    ['低', 'low'],
    ['中', 'medium'],
    ['高', 'high'],
    ['极高', 'xhigh'],
  ]) {
    await pick(name, level);
    colours[level] = await heading.evaluate((el) => getComputedStyle(el).color);
    await expect(tick).toHaveCSS('color', colours[level]);
    sweeps[level] = (await running()).find((a) => a.name === 'effort-sweep')!.duration;
    expect(await names()).not.toContain('effort-spin');
    await expect(page.locator('.effort-flare')).toHaveCount(0);
    expect(await aboveHandleMoves()).toBe(false);
  }
  expect(new Set(Object.values(colours)).size).toBe(4);
  // The harder Claude thinks, the quicker the sweep.
  expect(sweeps.low).toBeGreaterThan(sweeps.medium);
  expect(sweeps.medium).toBeGreaterThan(sweeps.high);
  expect(sweeps.high).toBeGreaterThan(sweeps.xhigh);
  // 高 keeps the accent the title had before.
  await pick('高', 'high');
  expect(await heading.evaluate((el) => getComputedStyle(el).color)).toBe(
    await page.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--accent)';
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }),
  );

  await pick('最高', 'max');
  const flare = page.locator('.effort-flare');
  await expect(flare).toHaveAttribute('aria-hidden', 'true');
  await expect(flare.locator('.effort-ring')).toHaveCount(1);
  await expect(flare.locator('i')).toHaveCount(7);
  const burning = await running();
  for (const name of ['effort-sweep', 'effort-flow', 'effort-spin', 'effort-ember', 'effort-title'])
    expect(burning.map((a) => a.name)).toContain(name);
  expect(burning.find((a) => a.name === 'effort-sweep')!.duration).toBeLessThan(sweeps.xhigh);
  // The ring sits round the handle, which is at the end of the track.
  const [ring, track] = [
    (await flare.locator('.effort-ring').boundingBox())!,
    (await slider.boundingBox())!,
  ];
  expect(Math.abs(ring.x + ring.width / 2 - (track.x + track.width - 15))).toBeLessThan(1.5);
  // The title is drawn by its gradient (the text itself is clear) and the tick keeps the level's colour.
  await expect(heading).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  await expect(heading).toHaveCSS('background-clip', 'text');
  const maxText = await view.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--effort-text'),
  );
  expect(maxText.trim()).not.toBe('');
  expect(await aboveHandleMoves()).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(async () => [...(await names())].filter((n) => n.startsWith('effort-')))
    .toEqual([]);
  await expect(flare.locator('i').first()).toBeHidden();
  expect(await aboveHandleMoves()).toBe(false);
});

// Spec §5.10: with nothing known the button names the default model and no level, and the menu says the model
// decides instead of showing an empty track; the levels are plain choices, and choosing one brings the slider.
test('an unknown model and effort read as the defaults, and the levels can still be chosen', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/test/fixtures/model-controls.tsx';
    (await import(path)).mount({ effort: null, bare: true });
  });
  const trigger = page.getByRole('button', { name: '模型与推理强度', exact: true });
  await expect(trigger).toHaveText('默认模型');
  await expect(trigger.locator('small')).toHaveCount(0);
  await page.getByRole('button', { name: '上下文窗口', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('上下文窗口正在读取…');
  await trigger.click();
  await expect(page.locator('.effort-heading')).toHaveText('推理强度：跟随模型');
  await expect(page.locator('.effort-ticks')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: '推理强度', exact: true })).toHaveCount(0);

  await page.evaluate(async () => {
    const path = '/test/fixtures/model-controls.tsx';
    (await import(path)).mount({ effort: null });
  });
  await expect(trigger).toHaveText('Opus 5.5');
  await trigger.click();
  const heading = page.locator('.effort-heading');
  await expect(heading).toHaveText('推理强度：跟随模型');
  const colours = await page.evaluate(() => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const read = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const result = { text: read('--text-2'), accent: read('--accent') };
    probe.remove();
    return result;
  });
  await expect(heading).toHaveCSS('color', colours.text);
  await expect(page.getByRole('slider', { name: '推理强度', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '恢复默认推理强度' })).toHaveCount(0);
  const choices = page.getByRole('group', { name: '选择推理强度' }).getByRole('button');
  await expect(choices).toHaveText(['低', '中', '高', '极高', '最高']);
  // One row, reachable with Tab.
  const rows = await choices.evaluateAll(
    (nodes) => new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().top))).size,
  );
  expect(rows).toBe(1);
  await choices.nth(3).focus();
  await expect(choices.nth(3)).toBeFocused();
  await choices.nth(3).click();
  await expect(page.getByLabel('已提交')).toHaveText('["xhigh"]');
  const slider = page.getByRole('slider', { name: '推理强度', exact: true });
  await expect(slider).toHaveAttribute('aria-valuetext', '极高');
  await expect(heading).toHaveText('极高');
  await expect(heading).not.toHaveCSS('color', colours.text);
  await expect(trigger.locator('small')).toHaveText('极高');
});
