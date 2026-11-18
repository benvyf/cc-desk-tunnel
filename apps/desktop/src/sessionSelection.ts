// Choosing several sessions in the sidebar, and acting on them one after another (Sidebar.tsx, App.tsx).

export function toggled(selection: ReadonlySet<string>, id: string) {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
// From the anchor to the row pressed, in the order the rows are shown, added to what was chosen.
export function ranged(
  selection: ReadonlySet<string>,
  shown: string[],
  anchor: string | undefined,
  to: string,
) {
  const end = shown.indexOf(to);
  const start = anchor === undefined ? -1 : shown.indexOf(anchor);
  if (end < 0) return new Set(selection);
  const [from, until] = start < 0 ? [end, end] : [Math.min(start, end), Math.max(start, end)];
  return new Set([...selection, ...shown.slice(from, until + 1)]);
}
// What is chosen and still there to choose: a row folded away, filtered out, deleted or now at work drops out.
export function pruned(selection: ReadonlySet<string>, choosable: ReadonlySet<string>) {
  const next = new Set([...selection].filter((id) => choosable.has(id)));
  return next.size === selection.size ? selection : next;
}

export type BatchFailure = { id: string; title: string; code?: string; message: string };
// Each in turn, never side by side: the service changes one session's native record at a time and turns away a
// second change meanwhile. What failed is told one by one; `gone` counts as done (a delete of what is no longer
// there).
export async function runBatch(
  items: { id: string; title: string }[],
  act: (id: string) => Promise<unknown>,
  progress?: (done: number, total: number) => void,
  gone = (code?: string) => code === 'not_found',
) {
  const done: string[] = [];
  const failed: BatchFailure[] = [];
  for (const [index, item] of items.entries()) {
    progress?.(index, items.length);
    try {
      await act(item.id);
      done.push(item.id);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (gone(code)) done.push(item.id);
      else
        failed.push({
          id: item.id,
          title: item.title,
          code,
          message: error instanceof Error ? error.message : '操作失败',
        });
    }
  }
  progress?.(items.length, items.length);
  return { done, failed };
}
