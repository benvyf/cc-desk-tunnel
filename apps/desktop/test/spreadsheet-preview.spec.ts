import { expect, test } from '@playwright/test';
import { utils, write } from 'xlsx';

const fixtures: Record<string, string> = {};
for (const format of ['xlsx', 'xls'] as const) {
  const book = utils.book_new();
  const sheet = utils.aoa_to_sheet([
    ['姓名', '金额', '编号'],
    ['张三', 1234.5, '00123'],
  ]);
  sheet.B2.z = '#,##0.00';
  utils.book_append_sheet(book, sheet, '收入');
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([['<img src=x onerror=alert(1)>', '=1+2']]),
    '备注',
  );
  fixtures[format] = write(book, { type: 'base64', bookType: format });
}
fixtures.csv = Buffer.from(
  '编号,说明\r\n00123,"第一行\n第二行,内容"\r\n=1+2,保留公式文本',
).toString('base64');
fixtures.tsv = Buffer.from(
  Array.from({ length: 5000 }, (_, i) =>
    i > 0 && i < 4999 && i % 7 === 0 ? `${i}\t"第${i}行\n第二段"` : `${i}\t第${i}行`,
  ).join('\n'),
).toString('base64');
fixtures.bad = Buffer.from('not Excel').toString('base64');
test.beforeEach(async ({ page }) => {
  await page.addInitScript((fixtures) => {
    (window as any).spreadsheetFixtures = fixtures;
  }, fixtures);
  await page.goto('/test/fixtures/spreadsheet-preview.html');
});
for (const format of ['xlsx', 'xls'])
  test(`${format} opens a read-only grid with sheet navigation and escaped values`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('button', { name: `打开 ${format}`, exact: true }).click();
    const table = page.getByRole('table', { name: '工作表 收入' });
    await expect(table.getByRole('cell', { name: '张三', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: '1,234.50', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: '00123', exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'A', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '备注', exact: true }).click();
    const other = page.getByRole('table', { name: '工作表 备注' });
    await expect(
      other.getByRole('cell', { name: '<img src=x onerror=alert(1)>', exact: true }),
    ).toBeVisible();
    await expect(other.locator('img,input,[contenteditable]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
test('CSV retains multiline fields and identifiers; TSV scrolls with bounded DOM rows', async ({
  page,
}) => {
  await page.getByRole('button', { name: '打开 csv', exact: true }).click();
  await expect(page.getByRole('cell', { name: '00123', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '=1+2', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '第一行 第二行,内容', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开 tsv', exact: true }).click();
  const table = page.getByRole('table', { name: '工作表 TSV' });
  await expect(table.getByRole('cell', { name: '第0行', exact: true })).toBeVisible();
  expect(await table.getByRole('row').count()).toBeLessThan(100);
  const heights = await table
    .locator('tbody tr:not([aria-hidden])')
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(heights.every((height) => height === 32)).toBe(true);
  await page.getByLabel('表格滚动区域').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(table.getByRole('cell', { name: '第4999行', exact: true })).toBeVisible();
  expect(await table.getByRole('row').count()).toBeLessThan(100);
});

test('sheet tabs support keyboard switching and corrupt workbooks leave an actionable error', async ({
  page,
}) => {
  await page.getByRole('button', { name: '打开 xlsx', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: '工作表', exact: true });
  await tabs.getByRole('tab', { name: '收入', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: '备注', exact: true })).toBeFocused();
  await expect(page.getByRole('table', { name: '工作表 备注' })).toBeVisible();
  await page.keyboard.press('Home');
  await expect(page.getByRole('table', { name: '工作表 收入' })).toBeVisible();
  await page.getByRole('button', { name: '打开 bad', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('有效');
  await expect(page.getByRole('button', { name: '在系统应用中打开', exact: true })).toBeVisible();
});

for (const theme of ['light', 'dark'])
  test(`spreadsheet scrolling stays inside its sidebar on a narrow ${theme} screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.getByRole('button', { name: '打开 xlsx', exact: true }).click();
    const table = page.getByRole('table', { name: '工作表 收入' });
    await expect(table).toBeVisible();
    await expect
      .poll(() => page.getByLabel('表格滚动区域').evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `.local/spreadsheet-${theme}.png` });
  });

test('stalled workers are terminated on timeout and stale callbacks cannot replace another file', async ({
  page,
}) => {
  await page.clock.install();
  await page.evaluate(() => {
    const workers: any[] = [];
    (window as any).previewWorkers = workers;
    (window as any).Worker = class {
      onmessage: ((event: unknown) => void) | null = null;
      stopped = false;
      constructor() {
        workers.push(this);
      }
      postMessage() {}
      terminate() {
        this.stopped = true;
      }
    };
  });
  await page.getByRole('button', { name: '打开 xlsx', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).previewWorkers.length)).toBe(1);
  await page.getByRole('button', { name: '打开 csv', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).previewWorkers.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).previewWorkers[0].stopped)).toBe(true);
  await page.evaluate(() =>
    (window as any).previewWorkers[0].onmessage({
      data: {
        book: { sheets: [{ name: '旧文件', rows: [['过期数据']], columns: 1 }] },
      },
    }),
  );
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.clock.fastForward(15000);
  await expect(page.getByRole('alert')).toContainText('超时');
  expect(await page.evaluate(() => (window as any).previewWorkers[1].stopped)).toBe(true);
});
