// How much of the work behind a reply the conversation shows. `standard` is how it has always looked: while a turn
// runs its steps are in groups, folded; once it ends they fold into one line, "用时 …". `expanded` lays every call
// and thought out one after another, folds nothing, and shows a two-line preview of each folded thought.
export type ViewMode = 'standard' | 'expanded';
export type TranscriptView = { mode: ViewMode };

export const defaultView: TranscriptView = { mode: 'standard' };

export const viewModes: { mode: ViewMode; label: string; detail: string }[] = [
  { mode: 'standard', label: '标准', detail: '运行中按连续的操作分组，结束后折成“用时 …”' },
  {
    mode: 'expanded',
    label: '全部展开',
    detail: '命令和思考一条条平铺，不分组，也不自动收起；思考摘要最多显示两行',
  },
];

// Keep subsequent lines available to the two-line CSS clamp without parsing Markdown for a closed fold.
// Only Markdown list markers are removed; a number that starts a sentence stays.
export function thinkingPreview(text: string) {
  return text
    .replace(/^[\t ]*(?:>[\t ]*)*(?:#{1,6}[\t ]+|[-*+][\t ]+|\d+[.)][\t ]+)?/gm, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}
