import { expect, test } from '@playwright/test';
import { screenshots } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await page.goto('/test/fixtures/attachments.html');
});

test('files become removable tiles, images have thumbnails and attachment-only messages send paths', async ({
  page,
}) => {
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
  await expect(page.locator('.attachment-tile')).toHaveCount(2);
  await expect(page.getByAltText('风景.png')).toBeVisible();
  await page.getByRole('button', { name: '移除 schema.json', exact: true }).click();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  expect(await page.locator('main').getAttribute('data-sent')).toBe('"C:\\照片\\风景.png"');
});

test('attachments follow their session and survive reload without storing thumbnail data', async ({
  page,
}) => {
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('button', { name: '切换会话' }).click();
  await expect(page.locator('.attachment-tile')).toHaveCount(0);
  await page.getByRole('button', { name: '切换会话' }).click();
  await expect(page.locator('.attachment-tile')).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('attachment-test-drafts')))
    .toContain('schema.json');
  expect(await page.evaluate(() => localStorage.getItem('attachment-test-drafts'))).not.toContain(
    'base64',
  );
  await page.reload();
  await expect(page.locator('.attachment-tile')).toHaveCount(2);
});

test('clipboard preparation pulses, blocks send, keeps typing and stays in its original session', async ({
  page,
}) => {
  await page.getByRole('textbox', { name: '消息', exact: true }).evaluate((box) => {
    const data = new DataTransfer();
    data.items.add(new File(['image'], '截图.png', { type: 'image/png' }));
    box.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.attachment-tile[data-status="preparing"]')).toBeVisible();
  expect(
    await page
      .locator('.attachment-tile')
      .evaluate((tile) => getComputedStyle(tile, '::after').animationName),
  ).toBe('attachment-breathe');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('看看这张图');
  await page.getByRole('textbox', { name: '消息', exact: true }).press('Enter');
  expect(await page.locator('main').evaluate((root) => root.hasAttribute('data-sent'))).toBe(false);
  await page.getByRole('button', { name: '切换会话' }).click();
  await expect(page.locator('.attachment-tile')).toHaveCount(0);
  await page.getByRole('button', { name: '切换会话' }).click();
  await expect(page.locator('.attachment-tile[data-status="ready"]')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('看看这张图');
});

test('failed pictures remain visible and removable; cancelled preparation never reappears', async ({
  page,
}) => {
  await page.getByRole('button', { name: '模拟失败' }).click();
  const paste = () =>
    page.getByRole('textbox', { name: '消息', exact: true }).evaluate((box) => {
      const data = new DataTransfer();
      data.items.add(new File(['image'], '截图.png', { type: 'image/png' }));
      box.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
  await paste();
  await expect(page.locator('.attachment-status')).toContainText('添加失败');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '移除 截图.png', exact: true }).click();
  await paste();
  await page.getByRole('button', { name: '移除 截图.png', exact: true }).click();
  await page.waitForTimeout(750);
  await expect(page.locator('.attachment-tile')).toHaveCount(0);
});

test('a dropped image without a filename extension still gets its saved image preview', async ({
  page,
}) => {
  await page.locator('.composer').evaluate((composer) => {
    const data = new DataTransfer();
    data.items.add(new File(['image'], '粘贴图片', { type: 'image/png' }));
    composer.dispatchEvent(
      new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByAltText('粘贴图片', { exact: true })).toBeVisible();
  await expect(page.locator('.attachment-kind')).toHaveText('IMAGE');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
});

test('extensionless files in dotted directories keep their file badge', async ({ page }) => {
  await page.evaluate(() => {
    window.desktop!.chooseFiles = async () => [
      'C:\\project.v1\\LICENSE',
      '/home/user/.config/NOTICE',
    ];
  });
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await expect(page.locator('.attachment-kind')).toHaveText(['FILE', 'FILE']);
  await expect(page.locator('.attachment-name')).toHaveText(['LICENSE', 'NOTICE']);
});

test('attachments count toward the message limit without truncating or losing the draft', async ({
  page,
}) => {
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  const text = '字'.repeat(16000);
  await input.fill(text);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await input.press('Enter');
  expect(await page.locator('main').getAttribute('data-sent')).toBeNull();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('16000');
  await expect(input).toHaveValue(text);
  await expect(page.locator('.attachment-tile')).toHaveCount(2);
  await input.fill('缩短后的正文');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await input.press('Enter');
  expect(await page.locator('main').getAttribute('data-sent')).toContain(
    '缩短后的正文\n"C:\\资料\\schema.json"',
  );
  const suffix = '\n"C:\\资料\\schema.json"\n"C:\\照片\\风景.png"';
  await input.fill('字'.repeat(16000 - suffix.length));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await input.press('Enter');
  expect((await page.locator('main').getAttribute('data-sent'))?.length).toBe(16000);
});

test('a delayed file chooser adds only to its original session', async ({ page }) => {
  await page.evaluate(() => {
    window.desktop!.chooseFiles = () =>
      new Promise((resolve) => {
        Object.assign(window, { finishChooseFiles: () => resolve(['C:\\资料\\delayed.pdf']) });
      });
  });
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('button', { name: '切换会话' }).click();
  await page.evaluate(() =>
    (window as unknown as { finishChooseFiles: () => void }).finishChooseFiles(),
  );
  await expect(page.locator('.attachment-tile')).toHaveCount(0);
  await page.getByRole('button', { name: '切换会话' }).click();
  await expect(page.locator('.attachment-name')).toHaveText('delayed.pdf');
});

test('failed thumbnail requests settle without blocking or losing the attached file', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.desktop!.attachmentPreview = async () => {
      throw new Error('thumbnail unavailable');
    };
  });
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await expect(page.locator('.attachment-tile')).toHaveCount(2);
  await expect(page.locator('.attachment-tile[aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('.attachment-preview')).toHaveCount(0);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  expect(await page.locator('main').getAttribute('data-sent')).toContain('"C:\\照片\\风景.png"');
});

test('light/dark tiles keep reference geometry and narrow screens scroll without overflowing', async ({
  page,
}) => {
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: `${screenshots}/attachments-${scheme}.png`,
      animations: 'disabled',
    });
  }
  const tile = page.locator('.attachment-tile').first();
  await expect(tile).toHaveCSS('border-radius', '12px');
  expect((await tile.boundingBox())?.width).toBe(128);
  expect((await tile.boundingBox())?.height).toBe(96);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole('button', { name: '更多附件', exact: true }).click();
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await expect(page.locator('.attachment-tile')).toHaveCount(10);
  await expect
    .poll(() =>
      page
        .locator('.attachment-tiles')
        .evaluate((row) => row.scrollWidth - row.clientWidth - row.scrollLeft),
    )
    .toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/attachments-narrow.png`, animations: 'disabled' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.attachment-slot').first()).toHaveCSS('animation-name', 'none');
});

test('typing before disk loading completes preserves saved attachments, and adding files preserves saved text', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const seed = new URL(location.href).searchParams.get('seed');
    if (!seed) return;
    localStorage.setItem(
      'attachment-test-drafts',
      JSON.stringify({
        one: {
          text: seed === 'files' ? '磁盘正文' : '旧正文',
          attachments: [
            {
              id: 'saved',
              name: seed === 'alias' ? 'schema.json' : 'saved.pdf',
              path: seed === 'alias' ? 'C:\\资料\\schema.json' : 'C:\\资料\\saved.pdf',
              status: 'ready',
            },
          ],
        },
      }),
    );
  });
  await page.goto('/test/fixtures/attachments.html?loadDelay=1400&seed=text');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('新正文');
  await expect(page.locator('.attachment-name')).toHaveText('saved.pdf');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('新正文');
  await page.goto('/test/fixtures/attachments.html?loadDelay=1400&seed=files');
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('磁盘正文');
  await expect(page.locator('.attachment-tile')).toHaveCount(3);
  await page.goto('/test/fixtures/attachments.html?loadDelay=1400&seed=alias');
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('button', { name: '移除 schema.json', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('旧正文');
  await expect(page.locator('.attachment-name')).toHaveText('风景.png');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('attachment-test-drafts')))
    .not.toContain('schema.json');
});

test('reference file tiles match both themes and forced colors retain readable controls', async ({
  page,
}) => {
  await page.goto('/test/fixtures/attachments.html?reference=1');
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: `${screenshots}/attachments-reference-${scheme}.png`,
      animations: 'disabled',
    });
    await page.locator('.attachment-tiles').screenshot({
      path: `${screenshots}/attachments-reference-row-${scheme}.png`,
      animations: 'disabled',
    });
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  const remove = page.getByRole('button', { name: '移除 document-4.ts', exact: true });
  await remove.focus();
  await expect(remove).toBeFocused();
  await remove.press('Enter');
  await expect(page.locator('.attachment-tile')).toHaveCount(3);
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused();
});
