import assert from 'node:assert/strict';
import { test } from 'node:test';
import { utils, write } from 'xlsx';
import { zipSync } from 'fflate';
import { parseSpreadsheet } from '../src/spreadsheet.ts';

for (const format of ['xlsx', 'xls'] as const)
  test(`real ${format} values, sheets, dates and formulas are read without evaluation`, () => {
    const book = utils.book_new();
    const sheet = utils.aoa_to_sheet([
      ['姓名', '金额', '编号'],
      ['张三', 1234.5, '00123'],
    ]);
    sheet.B2.z = '#,##0.00';
    sheet.D2 = { t: 'n', v: 2469, f: 'B2*2' };
    sheet.E2 = { t: 'n', f: 'SUM(B2:D2)' };
    sheet.F2 = { t: 'n', v: 45292, z: 'yyyy-mm-dd' };
    sheet['!ref'] = 'A1:F2';
    utils.book_append_sheet(book, sheet, '收入');
    utils.book_append_sheet(book, utils.aoa_to_sheet([['<img src=x onerror=alert(1)>']]), '第二页');
    const result = parseSpreadsheet(
      new Uint8Array(write(book, { type: 'buffer', bookType: format })),
      format,
    );
    assert.deepEqual(
      result.sheets.map((sheet) => sheet.name),
      ['收入', '第二页'],
    );
    assert.equal(result.sheets[0].rows[1][0], '张三');
    assert.equal(result.sheets[0].rows[1][1], '1,234.50');
    assert.equal(result.sheets[0].rows[1][2], '00123');
    assert.equal(result.sheets[0].rows[1][3], '2469');
    assert.match(result.sheets[0].rows[1][5], /2024-01-01/);
    assert.equal(result.sheets[1].rows[0][0], '<img src=x onerror=alert(1)>');
  });

for (const [format, delimiter] of [
  ['csv', ','],
  ['tsv', '\t'],
] as const)
  test(`${format} preserves identifiers, quoted separators/newlines and authored formula text`, () => {
    const data = new TextEncoder().encode(
      '\ufeff编号' +
        delimiter +
        '说明\r\n00123' +
        delimiter +
        '"第一行\n第二行' +
        delimiter +
        '内容"\r\n=1+2' +
        delimiter +
        '"a""b"\r\n',
    );
    const { sheets } = parseSpreadsheet(data, format);
    assert.deepEqual(sheets[0].rows, [
      ['编号', '说明'],
      ['00123', '第一行\n第二行' + delimiter + '内容'],
      ['=1+2', 'a"b'],
    ]);
  });

test('corrupt, disguised and huge worksheets fail with a readable error', () => {
  assert.throws(() => parseSpreadsheet(new TextEncoder().encode('not Excel'), 'xlsx'), /有效|损坏/);
  assert.throws(
    () => parseSpreadsheet(new TextEncoder().encode('<html>renamed</html>'), 'xls'),
    /有效|损坏/,
  );
  const book = utils.book_new();
  utils.book_append_sheet(book, { A1: { t: 's', v: 'one' }, '!ref': 'A1:I30000' }, 'Huge');
  assert.throws(
    () =>
      parseSpreadsheet(new Uint8Array(write(book, { type: 'buffer', bookType: 'xlsx' })), 'xlsx'),
    /过大|限制/,
  );
});

test('formula without cached result stays a literal formula and empty workbook stays readable', () => {
  const book = utils.book_new();
  utils.book_append_sheet(book, { A1: { t: 'n', f: '1+2' }, '!ref': 'A1' }, '公式');
  const result = parseSpreadsheet(
    new Uint8Array(write(book, { type: 'buffer', bookType: 'xlsx' })),
    'xlsx',
  );
  assert.equal(result.sheets[0].rows[0][0], '=1+2');
});

test('delimited text preserves internal empty rows and rejects broken quotes', () => {
  assert.deepEqual(
    parseSpreadsheet(new TextEncoder().encode('a,b\n\nc,d\n'), 'csv').sheets[0].rows,
    [['a', 'b'], [''], ['c', 'd']],
  );
  assert.throws(() => parseSpreadsheet(new TextEncoder().encode('a,"unclosed'), 'csv'), /格式无效/);
  assert.deepEqual(parseSpreadsheet(new Uint8Array(), 'csv').sheets[0].rows, []);
});

test('trailing empty records and quoted empty fields are data, not a synthetic final record', () => {
  for (const format of ['csv', 'tsv']) {
    for (const newline of ['\n', '\r\n', '\r']) {
      for (const [text, expected] of [
        ['a' + newline + newline, [['a'], ['']]],
        ['a' + newline + '""' + newline, [['a'], ['']]],
        ['""' + newline, [['']]],
        [newline, [['']]],
        ['a' + newline + newline + newline, [['a'], [''], ['']]],
        ['a' + newline, [['a']]],
      ] as [string, string[][]][]) {
        assert.deepEqual(
          parseSpreadsheet(new TextEncoder().encode(text), format).sheets[0].rows,
          expected,
          `${format}: ${JSON.stringify(text)}`,
        );
      }
    }
  }
});

test('empty records count toward the CSV row limit without counting the synthetic final record', () => {
  const text = 'value\n'.repeat(10000);
  assert.equal(
    parseSpreadsheet(new TextEncoder().encode(text), 'csv').sheets[0].rows.length,
    10000,
  );
  assert.throws(() => parseSpreadsheet(new TextEncoder().encode(text + '\n'), 'csv'), /过大|限制/);
});

test('UTF-16 delimited documents preserve Chinese and leading zeroes', () => {
  const text = '\ufeff编号\t值\r\n00123\t中文';
  const bytes = new Uint8Array(Buffer.from(text, 'utf16le'));
  assert.deepEqual(parseSpreadsheet(bytes, 'tsv').sheets[0].rows, [
    ['编号', '值'],
    ['00123', '中文'],
  ]);
});

test('hidden sheets stay hidden and sheet count limits do not truncate files silently', () => {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([['visible']]), '显示');
  utils.book_append_sheet(book, utils.aoa_to_sheet([['private']]), '隐藏');
  book.Workbook = {
    Sheets: [
      { name: '显示', Hidden: 0 },
      { name: '隐藏', Hidden: 1 },
    ],
  };
  const bytes = () => new Uint8Array(write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.deepEqual(
    parseSpreadsheet(bytes(), 'xlsx').sheets.map((sheet) => sheet.name),
    ['显示'],
  );
  for (let i = 2; i < 51; i++)
    utils.book_append_sheet(book, utils.aoa_to_sheet([[i]]), 'Sheet' + i);
  assert.throws(() => parseSpreadsheet(bytes(), 'xlsx'), /过大|限制/);
});

test('oversized XLSX expanded archives are rejected before decompression', () => {
  const bytes = zipSync({ 'xl/worksheets/sheet1.xml': new TextEncoder().encode('small') });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length - 24; i++) {
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 100 * 1024 * 1024, true);
      break;
    }
  }
  assert.throws(() => parseSpreadsheet(bytes, 'xlsx'), /过大|限制/);
});
