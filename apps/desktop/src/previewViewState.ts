import type { PreviewBoard } from './previewLayout.ts';

export type ReadingPosition = { top: number; left: number };
export type PdfReading = ReadingPosition & { kind: 'pdf'; page: number; zoom: number };
export type PreviewReading =
  | (ReadingPosition & { kind: 'text' })
  | { kind: 'markdown'; source: boolean; preview: ReadingPosition; code: ReadingPosition }
  | PdfReading;
export type PreviewReadingSessions = Record<string, Record<string, PreviewReading>>;

const readingByteLimit = 256 * 1024;
const layoutCharacterLimit = 2_000_000;
const utf8 = new TextEncoder();
const withinReadingLimit = (value: unknown) =>
  utf8.encode(JSON.stringify(value)).byteLength <= readingByteLimit;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const bound = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
const position = (value: unknown): ReadingPosition => ({
  top: bound(record(value) ? value.top : undefined, 0, 10_000_000, 0),
  left: bound(record(value) ? value.left : undefined, 0, 10_000_000, 0),
});

export function cleanReading(value: unknown): PreviewReading | undefined {
  if (!record(value)) return undefined;
  if (value.kind === 'text') return { kind: 'text', ...position(value) };
  if (value.kind === 'markdown')
    return {
      kind: 'markdown',
      source: value.source === true,
      preview: position(value.preview),
      code: position(value.code),
    };
  if (value.kind === 'pdf')
    return {
      kind: 'pdf',
      page: Math.trunc(bound(value.page, 1, Number.MAX_SAFE_INTEGER, 1)),
      zoom: Math.round(bound(value.zoom, 0.5, 3, 1) * 4) / 4,
      ...position(value),
    };
  return undefined;
}

export function readPreviewReading(
  serialized: string | null,
  boards: Record<string, PreviewBoard>,
): PreviewReadingSessions {
  if (!serialized || serialized.length > layoutCharacterLimit) return {};
  try {
    const input: unknown = JSON.parse(serialized);
    if (!record(input) || !record(input.reading) || input.reading.version !== 1) return {};
    if (!withinReadingLimit(input.reading)) return {};
    return ownedReading(input.reading.sessions, boards);
  } catch {
    return {};
  }
}

const safeKey = (key: string) =>
  key.length > 0 &&
  key.length <= 4096 &&
  !key.includes('\0') &&
  !['__proto__', 'constructor', 'prototype'].includes(key);

function ownedReading(
  value: unknown,
  boards: Record<string, PreviewBoard>,
): PreviewReadingSessions {
  const sessions: PreviewReadingSessions = {};
  if (!record(value)) return sessions;
  for (const [session, board] of Object.entries(boards).slice(0, 100)) {
    if (!safeKey(session) || !Object.hasOwn(value, session)) continue;
    const input = value[session];
    if (!record(input)) continue;
    const tabs: Record<string, PreviewReading> = {};
    for (const tab of board.tabs.slice(0, 64)) {
      if (tab.kind !== 'file' || !safeKey(tab.id) || !Object.hasOwn(input, tab.id)) continue;
      const reading = cleanReading(input[tab.id]);
      if (reading) tabs[tab.id] = reading;
    }
    if (Object.keys(tabs).length) sessions[session] = tabs;
  }
  return sessions;
}

export function clampPdfReading(state: PdfReading, numPages: number): PdfReading {
  const pages = Math.trunc(bound(numPages, 1, Number.MAX_SAFE_INTEGER, 1));
  return { ...state, page: Math.min(state.page, pages) };
}

export function serializePreviewState(
  layout: { width: number; boards: Record<string, PreviewBoard> },
  reading: PreviewReadingSessions,
): string {
  const sessions = ownedReading(reading, layout.boards);
  if (!Object.keys(sessions).length) return JSON.stringify(layout);
  const metadata = { version: 1, sessions };
  if (!withinReadingLimit(metadata)) return JSON.stringify(layout);
  const serialized = JSON.stringify({ ...layout, reading: metadata });
  return serialized.length <= layoutCharacterLimit ? serialized : JSON.stringify(layout);
}
