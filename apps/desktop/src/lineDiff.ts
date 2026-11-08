// Which lines of a text went out and which came in, for a tool call's change to a file: shown as a diff under
// the call (ToolInput.tsx) and counted in its line (activity.ts).
// One line of a diff: kept, taken out or put in.
export type Line = { kind: ' ' | '-' | '+'; text: string };
// Lines in common are found by their longest common run; past a size where that costs too much, the old text is
// shown taken out and the new put in, whole.
const LIMIT = 250_000;
export function diffLines(before: string, after: string): Line[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  if (!a.length) return b.map((line) => ({ kind: '+', text: line }));
  if (!b.length) return a.map((line) => ({ kind: '-', text: line }));
  // Lines shared at both ends need no table.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const middle: Line[] = [];
  if (x.length * y.length > LIMIT) {
    middle.push(...x.map((line) => ({ kind: '-' as const, text: line })));
    middle.push(...y.map((line) => ({ kind: '+' as const, text: line })));
  } else {
    const table = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        table[i][j] =
          x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        middle.push({ kind: ' ', text: x[i] });
        i++;
        j++;
      } else if (i < x.length && (j === y.length || table[i + 1][j] >= table[i][j + 1])) {
        middle.push({ kind: '-', text: x[i++] });
      } else middle.push({ kind: '+', text: y[j++] });
    }
  }
  return [
    ...a.slice(0, head).map((line) => ({ kind: ' ' as const, text: line })),
    ...middle,
    ...a.slice(a.length - tail).map((line) => ({ kind: ' ' as const, text: line })),
  ];
}
// How many lines came in and went out.
export function lineChanges(before: string, after: string) {
  let added = 0;
  let removed = 0;
  for (const line of diffLines(before, after))
    if (line.kind === '+') added++;
    else if (line.kind === '-') removed++;
  return { added, removed };
}
