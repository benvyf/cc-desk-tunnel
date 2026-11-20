// Decoding of the bytes of a previewed text file. It is kept apart from the file server so the
// encoding and truncation rules can be tested on plain buffers.

const textLimit = 4 * 1024 * 1024;
// Where a cut file has a line break this close to its end, it ends there rather than mid-line.
const lineWindow = 64 * 1024;
const sampleBytes = 4096;

let gb18030Available;
// Electron and Node ship full ICU, which has GB18030 (a superset of GBK); a build without it keeps
// the plain "not UTF-8" answer instead of failing differently.
function gb18030() {
  if (gb18030Available === undefined) {
    try {
      new TextDecoder('gb18030', { fatal: true });
      gb18030Available = true;
    } catch {
      gb18030Available = false;
    }
  }
  return gb18030Available;
}

// A file without a byte order mark is taken for UTF-16LE only when its sample looks like mostly
// Latin text in that form: a zero high byte in most characters and almost never a zero low byte.
function looksUtf16le(data) {
  const length = Math.min(data.length, sampleBytes) & ~1;
  if (length < 8) return false;
  let highZeros = 0,
    lowZeros = 0;
  for (let index = 0; index < length; index += 2) {
    if (data[index] === 0) lowZeros++;
    if (data[index + 1] === 0) highZeros++;
  }
  const pairs = length / 2;
  return highZeros / pairs >= 0.6 && lowZeros / pairs <= 0.02;
}

// Control characters other than tab, line breaks, form feed and escape (ANSI colours in logs) mark
// bytes that a fallback encoding happened to accept but that are not text.
function looksBinary(text) {
  const sample = text.slice(0, sampleBytes);
  let controls = 0;
  for (let index = 0; index < sample.length; index++) {
    const code = sample.charCodeAt(index);
    if (code === 0) return true;
    if (code < 32 && ![9, 10, 11, 12, 13, 27].includes(code)) controls++;
  }
  return controls > Math.max(2, sample.length * 0.01);
}

// Decodes strictly. A cut file may end inside a character; then up to three trailing bytes (two
// units for UTF-16) are left out, which is always a character boundary for these encodings.
function decodeStrict(label, data, cut) {
  const decoder = new TextDecoder(label, { fatal: true });
  const unit = label.startsWith('utf-16') ? 2 : 1;
  let end = unit === 2 ? data.length & ~1 : data.length;
  for (let dropped = 0; ; dropped += unit) {
    try {
      return decoder.decode(data.subarray(0, end - dropped));
    } catch (error) {
      if (!cut || dropped + unit > 3 || end - dropped - unit < 0) throw error;
    }
  }
}

// A cut text ends after its last line break when there is one near the end, and never after the
// first half of a surrogate pair.
function endCut(text) {
  const line = text.lastIndexOf('\n');
  if (line >= 0 && line >= text.length - lineWindow) return text.slice(0, line + 1);
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

const unsupported = () => new Error('此文件暂不支持预览，请在系统应用中打开。');

// Returns { text, encoding } where encoding is 'utf-8', 'utf-16le', 'utf-16be' or 'gb18030'.
// `cut` says the bytes are the start of a longer file.
function decodeText(data, { cut = false } = {}) {
  const finish = (text, encoding) => ({ text: cut ? endCut(text) : text, encoding });
  let utf16;
  if (data[0] === 0xff && data[1] === 0xfe) utf16 = 'utf-16le';
  else if (data[0] === 0xfe && data[1] === 0xff) utf16 = 'utf-16be';
  if (utf16) {
    let text;
    try {
      // TextDecoder drops the byte order mark itself.
      text = decodeStrict(utf16, data, cut);
    } catch {
      throw unsupported();
    }
    if (text.includes('\0')) throw unsupported();
    return finish(text, utf16);
  }
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    if (data.includes(0)) throw unsupported();
    try {
      return finish(decodeStrict('utf-8', data, cut), 'utf-8');
    } catch {
      throw new Error('此文件不是 UTF-8 文本，请在系统应用中打开。');
    }
  }
  if (looksUtf16le(data)) {
    try {
      const text = decodeStrict('utf-16le', data, cut);
      if (!looksBinary(text)) return finish(text, 'utf-16le');
    } catch {}
  }
  // After UTF-16 is ruled out, a zero byte means a binary file (an image, an archive, a program).
  if (data.includes(0)) throw unsupported();
  try {
    return finish(decodeStrict('utf-8', data, cut), 'utf-8');
  } catch {}
  if (gb18030()) {
    try {
      const text = decodeStrict('gb18030', data, cut);
      if (!looksBinary(text)) return finish(text, 'gb18030');
    } catch {}
  }
  throw new Error('此文件不是 UTF-8 文本，请在系统应用中打开。');
}

module.exports = { decodeText, textLimit };
