export function codeLineStarts(text: string): Uint32Array {
  const starts = [0];
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) === 13 && text.charCodeAt(at + 1) === 10) at++;
    if (text.charCodeAt(at) === 10 || text.charCodeAt(at) === 13) starts.push(at + 1);
  }
  return Uint32Array.from(starts);
}

export function requestedLine(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return;
  const line = Number(value);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

export function codePosition(
  text: string,
  line: number,
  column = 1,
  starts = codeLineStarts(text),
) {
  const row = Math.max(1, Math.min(starts.length, requestedLine(line) ?? 1));
  const start = starts[row - 1];
  let end = row < starts.length ? starts[row] - 1 : text.length;
  if (end > start && text.charCodeAt(end - 1) === 13) end--;
  return { line: row, start, end, offset: Math.min(end, start + (requestedLine(column) ?? 1) - 1) };
}
