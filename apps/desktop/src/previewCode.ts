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

// Text to look for in a file, and how many lines below where it starts the place sought is (or above, when
// negative).
export type FindTarget = { text: string; offset: number };
// Line breaks as one kind, as codeLineStarts counts them: \r\n, and a lone \r, are each one break.
const plainBreaks = (text: string) => text.replace(/\r\n?/g, '\n');

// The line the first of these texts that is found leads to, as an edit's text is looked for in its file
// (ToolInput.tsx); none when none is found.
export function foundLine(text: string, find: FindTarget[]): number | undefined {
  const plain = plainBreaks(text);
  for (const { text: value, offset } of find) {
    const at = value ? plain.indexOf(plainBreaks(value)) : -1;
    if (at < 0) continue;
    let line = 1;
    for (
      let index = plain.indexOf('\n');
      index >= 0 && index < at;
      index = plain.indexOf('\n', index + 1)
    )
      line++;
    return Math.max(1, line + offset);
  }
}

// What to look for to find an edit in its file, the likeliest first: the whole new text, which leads to its first
// changed line past the lines it shares with the old text at its start; then the new text from that line (the
// lines before it may have changed since); then the old text, for an edit not made yet; then the first line of
// the change and of the old text. A short first line ("}") would be found anywhere, so it is not looked for.
// Each text is cut short, which still finds where it starts. `diff` is the edit's diffLines.
export function editTargets(
  before: string,
  after: string,
  diff: { kind: string }[],
  longest = 2000,
): FindTarget[] {
  const old = plainBreaks(before),
    now = plainBreaks(after);
  const shared = Math.max(
    0,
    diff.findIndex((line) => line.kind !== ' '),
  );
  const changed = now.split('\n').slice(shared).join('\n');
  // Leading empty lines would be found at the end of any line before them: they are skipped, and counted back.
  const target = (text: string, offset: number): FindTarget => {
    const skipped = /^\n*/.exec(text)![0].length;
    return { text: text.slice(skipped, skipped + longest), offset: offset - skipped };
  };
  const first = (text: string, offset: number) => {
    const lines = text.split('\n');
    const index = lines.findIndex((line) => line.trim());
    const line = index < 0 ? '' : lines[index]!.trim();
    return line.length >= 8 ? { text: line.slice(0, longest), offset: offset - index } : null;
  };
  const found: FindTarget[] = [];
  for (const item of [
    target(now, shared),
    target(changed, 0),
    target(old, shared),
    first(changed, 0),
    first(old, shared),
  ])
    if (item && item.text.trim() && !found.some((other) => other.text === item.text))
      found.push(item);
  return found;
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
