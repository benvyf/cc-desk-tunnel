import { test, expect } from '@playwright/test';

// The terminal window's list of terminals as a menu (audit G2), its draft as a small input box (audit G3), and
// the preview's heading in two rows (audit H1).
test('all terminals open as a menu: the search on top, one plain row per terminal, actions under a rule', async ({
  page,
}) => {
  await page.goto('/test/terminal-window.fixture.html');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  const list = page.locator('.terminal-list');
  const search = list.getByRole('textbox', { name: '搜索项目、设备或已打开的终端', exact: true });
  await expect(search).toBeFocused();
  // The search is the menu's first row, inside its box.
  const box = (await list.boundingBox())!;
  const field = (await search.boundingBox())!;
  expect(field.y - box.y).toBeLessThan(12);
  expect(field.x).toBeGreaterThanOrEqual(box.x);
  expect(field.x + field.width).toBeLessThanOrEqual(box.x + box.width);
  const rows = list.getByRole('group', { name: '已打开', exact: true }).getByRole('option');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row).toHaveCSS('border-top-width', '0px');
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  }
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  await expect(list.locator('hr')).toHaveCount(1);
  for (const name of ['打开其他目录…']) {
    const action = list.getByRole('button', { name, exact: true });
    await expect(action).toHaveCSS('border-top-width', '0px');
    await expect(action.locator('svg')).toHaveCount(1);
  }
  await search.press('Escape');
  await expect(list).toHaveCount(0);
});

test('the draft is a small input box: attach at its lower left, paste as its main action, the rest behind "…"', async ({
  page,
}) => {
  await page.goto('/test/terminal-window.fixture.html');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: '编辑输入', exact: true }).click();
  const card = page.locator('.terminal-panel:visible .terminal-draft-card');
  const text = card.getByRole('textbox', { name: '多行终端草稿', exact: true });
  await expect(text).toBeFocused();
  await text.fill('第一行\n第二行');
  const paste = card.getByRole('button', { name: '粘贴到终端', exact: true });
  const attach = card.getByRole('button', { name: '添加附件', exact: true });
  await expect(paste).toHaveClass(/primary/);
  const area = (await card.boundingBox())!;
  const pasteBox = (await paste.boundingBox())!;
  const attachBox = (await attach.boundingBox())!;
  const textBox = (await text.boundingBox())!;
  // Both sit under the text, attach at the left edge and paste at the right edge.
  expect(attachBox.y).toBeGreaterThan(textBox.y + textBox.height - 1);
  expect(attachBox.x - area.x).toBeLessThan(16);
  expect(area.x + area.width - (pasteBox.x + pasteBox.width)).toBeLessThan(16);
  // Copying and clearing are in the "…" list, which closes again with Escape or a press elsewhere.
  await expect(card.getByRole('button', { name: '复制文本', exact: true })).toHaveCount(0);
  const more = card.getByRole('button', { name: '更多操作', exact: true });
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu', { name: '草稿操作', exact: true });
  await expect(menu.getByRole('menuitem')).toHaveText(['复制文本', '清空']);
  await page.keyboard.press('Escape');
  await more.click();
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);
  await more.click();
  await menu.getByRole('menuitem', { name: '清空', exact: true }).click();
  await expect(text).toHaveValue('');
});

test('the preview heading is two rows: the tabs with every control, then the path', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  const aside = page.getByRole('complementary', { name: '文件与网站预览' });
  await expect(aside.getByRole('tab')).toHaveCount(1);
  // No separate "预览" row and no "预览窗格" row: the controls end the tab row.
  await expect(aside.locator('.preview-heading')).toHaveCount(0);
  const row = aside.locator('.preview-pane-heading');
  await expect(row).toHaveCount(1);
  for (const name of [
    '分栏预览',
    '浮动预览',
    '工作区目录',
    '打开本机文件',
    '打开本机网站',
    '放大预览',
    '收起预览',
  ])
    await expect(row.getByRole('button', { name, exact: true })).toBeVisible();
  const tab = (await row.getByRole('tab').first().boundingBox())!;
  const close = (await row.getByRole('button', { name: '收起预览', exact: true }).boundingBox())!;
  expect(Math.abs(tab.y + tab.height / 2 - (close.y + close.height / 2))).toBeLessThan(4);
  const toolbar = aside.locator('.preview-toolbar');
  const rowBox = (await row.boundingBox())!;
  const toolbarBox = (await toolbar.boundingBox())!;
  expect(Math.abs(toolbarBox.y - (rowBox.y + rowBox.height))).toBeLessThan(2);
  const top = (await aside.boundingBox())!.y;
  expect(toolbarBox.y + toolbarBox.height - top).toBeLessThan(90);
  // Enlarging is an icon that says what it does, and says the way back once pressed.
  await row.getByRole('button', { name: '放大预览', exact: true }).click();
  await expect(row.getByRole('button', { name: '还原预览', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await row.getByRole('button', { name: '还原预览', exact: true }).click();
  // A floating pane keeps its own row, moved by its name; the controls stay with the docked pane.
  await page.getByRole('button', { name: '图片状态', exact: true }).click();
  await row.getByRole('button', { name: '浮动预览', exact: true }).click();
  const floating = page.locator('.preview-pane-floating .preview-pane-heading');
  await expect(floating.locator('.preview-pane-grip')).toHaveText('浮动预览');
  await expect(floating.getByRole('button', { name: '停靠预览', exact: true })).toBeVisible();
  await expect(floating.getByRole('button', { name: '收起预览', exact: true })).toHaveCount(0);
});
