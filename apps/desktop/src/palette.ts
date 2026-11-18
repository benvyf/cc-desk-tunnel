// The command palette's entries and how a query ranks them (CommandPalette.tsx). Only what this window already
// holds: sessions, projects, settings, actions and the slash commands the CLI reported. Nothing here talks to the
// service; an entry's `run` does what the window's own controls do.

export type PaletteGroup = 'recent' | 'session' | 'project' | 'action' | 'setting' | 'command';
export type PaletteItem = {
  // Stable across openings, for what was used lately: `session:<id>`, `setting:<id>` and so on.
  id: string;
  group: Exclude<PaletteGroup, 'recent'>;
  label: string;
  detail?: string;
  // Matched besides the label: other names, and for fixed entries the initials of their pinyin.
  keywords?: string;
  hint?: string;
  // Why it cannot be chosen now.
  disabled?: string;
  // Recently used sessions first among equals.
  updatedAt?: string;
  run: () => void;
};

export const groupNames: Record<PaletteGroup, string> = {
  recent: '最近使用',
  session: '会话',
  project: '项目',
  action: '操作',
  setting: '设置',
  command: '斜杠命令',
};
const groupOrder: Exclude<PaletteGroup, 'recent'>[] = [
  'session',
  'project',
  'action',
  'setting',
  'command',
];
const groupLimit: Record<Exclude<PaletteGroup, 'recent'>, number> = {
  session: 8,
  project: 5,
  action: 20,
  setting: 20,
  command: 20,
};
const TOTAL = 50;

// How well a word matches a text: at its start, at a word's start, anywhere, or — for ASCII only, and in a label
// only, not in the long paths of details — its letters in order. Lower is better; null is no match.
function score(text: string, word: string, loose = true) {
  if (text.startsWith(word)) return 0;
  const at = text.indexOf(word);
  if (at > 0 && /[\s/._\-:（(]/.test(text[at - 1])) return 1;
  if (at > 0) return 2;
  if (loose && /^[\x20-\x7e]+$/.test(word)) {
    let from = 0;
    for (const letter of word) {
      from = text.indexOf(letter, from) + 1;
      if (!from) return null;
    }
    return 3;
  }
  return null;
}
// An entry's match: every word of the query must match its label, detail or keywords.
export function matchScore(item: PaletteItem, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const label = item.label.toLowerCase();
  const rest = [item.detail, item.keywords].filter(Boolean).join(' ').toLowerCase();
  let total = 0;
  for (const word of words) {
    const other = score(rest, word, false);
    const best = [score(label, word), other === null ? null : other + 1]
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)[0];
    if (best === undefined) return null;
    total += best;
  }
  return total;
}

export type PaletteSection = { group: PaletteGroup; items: PaletteItem[] };
// The entries for a query, in groups. With nothing typed, what was used lately leads; a query that starts with a
// slash looks among the slash commands only.
export function rank(items: PaletteItem[], query: string, recent: string[]): PaletteSection[] {
  const typed = query.trim();
  const commandsOnly = typed.startsWith('/');
  const words = commandsOnly ? typed.slice(1) : typed;
  const used = new Map(recent.map((id, index) => [id, index]));
  const scored = items
    .filter((item) => !commandsOnly || item.group === 'command')
    .map((item) => ({ item, score: words ? matchScore(item, words) : 0 }))
    .filter((entry): entry is { item: PaletteItem; score: number } => entry.score !== null)
    .sort(
      (a, b) =>
        a.score - b.score ||
        (used.get(a.item.id) ?? Infinity) - (used.get(b.item.id) ?? Infinity) ||
        (b.item.updatedAt ?? '').localeCompare(a.item.updatedAt ?? ''),
    );
  const sections: PaletteSection[] = [];
  let count = 0;
  const taken = new Set<string>();
  if (!typed) {
    const lately = recent
      .map((id) => items.find((item) => item.id === id))
      .filter((item): item is PaletteItem => !!item)
      .slice(0, 5);
    if (lately.length) {
      sections.push({ group: 'recent', items: lately });
      for (const item of lately) taken.add(item.id);
      count += lately.length;
    }
  }
  for (const group of groupOrder) {
    const members = scored
      .filter((entry) => entry.item.group === group && !taken.has(entry.item.id))
      .slice(0, Math.min(groupLimit[group], TOTAL - count))
      .map((entry) => entry.item);
    if (!members.length) continue;
    sections.push({ group, items: members });
    count += members.length;
    if (count >= TOTAL) break;
  }
  return sections;
}

// What was chosen lately, newest first, at most eight; an id no longer known is dropped when read.
export function pushRecent(recent: string[], id: string) {
  return [id, ...recent.filter((item) => item !== id)].slice(0, 8);
}
export function knownRecent(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.length < 200)
        .slice(0, 8)
    : [];
}
