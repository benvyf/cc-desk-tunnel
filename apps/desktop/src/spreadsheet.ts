import { read, set_cptable, utils, type WorkSheet } from 'xlsx';
import * as codepages from 'xlsx/dist/cpexcel.full.mjs';
import Papa from 'papaparse';
import { unzipSync } from 'fflate';

set_cptable(codepages);
export type Spreadsheet = { sheets: { name: string; rows: string[][]; columns: number }[] };
const maxRows = 10000,
  maxColumns = 256,
  maxCells = 200000,
  maxSheets = 50;
const tooLarge = () =>
  new Error('表格过大：预览最多支持 50 个工作表、10000 行、256 列和共 200000 个单元格。');

export function parseSpreadsheet(bytes: Uint8Array, format: string): Spreadsheet {
  if (bytes.byteLength > 20 * 1024 * 1024) throw tooLarge();
  if (format === 'csv' || format === 'tsv') {
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    let text: string;
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      throw new Error('表格文本须使用 UTF-8 或带 BOM 的 UTF-16 编码。');
    }
    if (text.includes('\0')) throw new Error('不是有效的文本表格。');
    const rows: string[][] = [];
    let columns = 0;
    let cursor = 0;
    let failure: Error | undefined;
    Papa.parse<string[]>(text, {
      delimiter: format === 'csv' ? ',' : '\t',
      skipEmptyLines: false,
      step(result, parser) {
        const start = cursor;
        cursor = result.meta.cursor;
        if (
          result.data.length === 1 &&
          result.data[0] === '' &&
          cursor === start &&
          cursor === text.length
        )
          return;
        columns = Math.max(columns, result.data.length);
        if (
          rows.length >= maxRows ||
          columns > maxColumns ||
          (rows.length + 1) * columns > maxCells
        ) {
          failure = tooLarge();
          parser.abort();
        } else if (result.errors.length) {
          failure = new Error('表格引号或分隔符格式无效。');
          parser.abort();
        } else rows.push(result.data);
      },
    });
    if (failure) throw failure;
    return { sheets: [{ name: format.toUpperCase(), rows, columns: Math.max(1, columns) }] };
  }
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const compound = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((n, i) => bytes[i] === n);
  const biff = bytes[0] === 9 && [0, 2, 4, 8].includes(bytes[1]);
  if (
    (format === 'xlsx' && !zip) ||
    (format === 'xls' && !compound && !biff) ||
    !['xls', 'xlsx'].includes(format)
  )
    throw new Error('不是有效的 Excel 文件，或文件已损坏。');
  if (format === 'xlsx') {
    let expanded = 0;
    // Read ZIP metadata only: do not allocate expanded payloads before enforcing the archive budget.
    try {
      unzipSync(bytes, {
        filter(entry) {
          expanded += entry.originalSize;
          if (expanded > 64 * 1024 * 1024) throw tooLarge();
          return false;
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('表格过大')) throw error;
      throw new Error('Excel 文件损坏或无法读取。');
    }
  }
  let book;
  try {
    book = read(bytes, {
      type: 'array',
      cellText: true,
      cellNF: true,
      cellFormula: true,
      sheetRows: maxRows + 1,
    });
  } catch {
    throw new Error('Excel 文件损坏或无法读取。');
  }
  if (book.SheetNames.length > maxSheets) throw tooLarge();
  let area = 0;
  const sheets: Spreadsheet['sheets'] = [];
  for (const [index, name] of book.SheetNames.entries()) {
    if (book.Workbook?.Sheets?.[index]?.Hidden) continue;
    const sheet: WorkSheet = book.Sheets[name];
    const range = utils.decode_range(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1');
    const rows = range.e.r + 1,
      columns = range.e.c + 1;
    area += rows * columns;
    if (!Number.isSafeInteger(area) || rows > maxRows || columns > maxColumns || area > maxCells)
      throw tooLarge();
    const values = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: columns }, (_, c) => {
        const cell = sheet[utils.encode_cell({ r, c })];
        if (!cell) return '';
        if (cell.v === undefined || cell.v === null) return cell.f ? '=' + cell.f : '';
        return String(cell.w ?? utils.format_cell(cell));
      }),
    );
    sheets.push({ name, rows: values, columns });
  }
  if (!sheets.length) throw new Error('没有可预览的可见工作表。');
  return { sheets };
}
