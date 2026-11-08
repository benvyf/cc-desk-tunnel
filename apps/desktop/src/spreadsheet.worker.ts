import { parseSpreadsheet } from './spreadsheet.ts';

self.onmessage = (event: MessageEvent<{ bytes: ArrayBuffer; format: string }>) => {
  try {
    self.postMessage({
      book: parseSpreadsheet(new Uint8Array(event.data.bytes), event.data.format),
    });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '无法读取表格。' });
  }
};
