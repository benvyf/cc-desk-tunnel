import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyBoard, openTab, restoreLayout } from '../src/previewLayout.ts';
import * as state from '../src/previewViewState.ts';

test('cleans only supported reading metadata and preserves independent Markdown positions', () => {
  assert.deepEqual(
    state.cleanReading({ kind: 'text', top: 120.5, left: 16, text: 'PRIVATE BODY' }),
    { kind: 'text', top: 120.5, left: 16 },
  );
  assert.deepEqual(
    state.cleanReading({
      kind: 'markdown',
      source: true,
      preview: { top: 300, left: 2, html: '<h1>PRIVATE BODY</h1>' },
      code: { top: 80, left: 20 },
      text: 'PRIVATE BODY',
    }),
    {
      kind: 'markdown',
      source: true,
      preview: { top: 300, left: 2 },
      code: { top: 80, left: 20 },
    },
  );
  for (const input of [null, 1, 'text', [], {}, { kind: 'html' }, { kind: 'image' }])
    assert.equal(state.cleanReading(input), undefined);
});

test('defaults invalid fields and bounds finite numeric offsets, page and zoom', () => {
  assert.deepEqual(state.cleanReading({ kind: 'text', top: -20, left: 20_000_000 }), {
    kind: 'text',
    top: 0,
    left: 10_000_000,
  });
  for (const value of [undefined, null, '12', true, NaN, Infinity, -Infinity, {}, []]) {
    assert.deepEqual(state.cleanReading({ kind: 'text', top: value, left: value }), {
      kind: 'text',
      top: 0,
      left: 0,
    });
    assert.deepEqual(state.cleanReading({ kind: 'pdf', page: value, zoom: value }), {
      kind: 'pdf',
      page: 1,
      zoom: 1,
      top: 0,
      left: 0,
    });
  }
  assert.deepEqual(state.cleanReading({ kind: 'markdown', source: 'true', preview: null }), {
    kind: 'markdown',
    source: false,
    preview: { top: 0, left: 0 },
    code: { top: 0, left: 0 },
  });
  for (const [page, zoom, expectedPage, expectedZoom] of [
    [3.9, 1.38, 3, 1.5],
    [-5, -4, 1, 0.5],
    [99, 10, 99, 3],
    [2, 1.24, 2, 1.25],
  ]) {
    assert.deepEqual(state.cleanReading({ kind: 'pdf', page, zoom, top: 50, left: 5 }), {
      kind: 'pdf',
      page: expectedPage,
      zoom: expectedZoom,
      top: 50,
      left: 5,
    });
  }
});

const fileBoard = (id = 'a') =>
  openTab(emptyBoard(), { id, kind: 'file', target: 'C:/work/document.txt' });
const textReading = (top: number): state.PreviewReading => ({ kind: 'text', top, left: 0 });
const stored = (sessions: unknown, version: unknown = 1) =>
  JSON.stringify({ reading: { version, sessions } });

test('old, damaged and unknown reading versions leave valid layout intact', () => {
  const layout = { width: 620, boards: { main: fileBoard() } };
  for (const reading of [
    undefined,
    null,
    [],
    'bad',
    {},
    { version: 2, sessions: { main: { a: textReading(4) } } },
  ]) {
    const serialized = JSON.stringify({ ...layout, reading });
    assert.deepEqual(state.readPreviewReading(serialized, layout.boards), {});
    assert.deepEqual(restoreLayout(serialized), restoreLayout(JSON.stringify(layout)));
  }
  for (const serialized of [null, '', '{broken', 'null', '[]', '1', '"x"', ' '.repeat(2_000_001)])
    assert.deepEqual(state.readPreviewReading(serialized, layout.boards), {});
});

test('reading restores by session and tab identity and ignores closed or unsupported owners', () => {
  const board = openTab(
    openTab(fileBoard(), { id: 'web', kind: 'web', target: 'http://localhost:3000/' }),
    {
      id: 'chat',
      kind: 'chat',
      target: '8c6f7703-9633-4fbe-a68f-4d5e2ba7fbd0',
    },
  );
  const boards = { main: board, side: fileBoard(), empty: emptyBoard() };
  const serialized = stored({
    main: {
      a: textReading(100),
      closed: textReading(5),
      web: textReading(6),
      chat: textReading(7),
    },
    side: { a: textReading(800) },
    empty: { a: textReading(90) },
    deleted: { a: textReading(500) },
  });
  assert.deepEqual(state.readPreviewReading(serialized, boards), {
    main: { a: textReading(100) },
    side: { a: textReading(800) },
  });
  assert.deepEqual(state.readPreviewReading(serialized, { side: boards.side }), {
    side: { a: textReading(800) },
  });
  assert.deepEqual(state.readPreviewReading(serialized, { main: fileBoard('new-id') }), {});
});

test('discarded layout owners cannot recover injected state or dangerous object keys', () => {
  const board = fileBoard();
  const serialized = JSON.stringify({
    boards: {
      main: {
        ...board,
        tabs: [...board.tabs, { id: 'remote', kind: 'file', target: '//server/secret' }],
      },
      ...JSON.parse('{"__proto__":{},"constructor":{},"prototype":{}}'),
    },
    reading: {
      version: 1,
      sessions: {
        main: {
          a: { kind: 'text', top: 20, left: 4, body: 'PRIVATE BODY', token: 'PRIVATE TOKEN' },
          remote: textReading(5),
          ...JSON.parse(
            '{"__proto__":{"kind":"text"},"constructor":{"kind":"text"},"prototype":{"kind":"text"}}',
          ),
        },
        ...JSON.parse(
          '{"__proto__":{"a":{"kind":"text"}},"constructor":{"a":{"kind":"text"}},"prototype":{"a":{"kind":"text"}}}',
        ),
      },
    },
  });
  const result = state.readPreviewReading(serialized, restoreLayout(serialized).boards);
  assert.deepEqual(result, { main: { a: { kind: 'text', top: 20, left: 4 } } });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  const dangerousBoards = Object.fromEntries(
    ['__proto__', 'constructor', 'prototype'].map((id) => [id, board]),
  );
  assert.deepEqual(state.readPreviewReading(serialized, dangerousBoards), {});
  for (const tabId of ['__proto__', 'constructor', 'prototype'])
    assert.deepEqual(
      state.readPreviewReading(stored({ main: JSON.parse(`{"${tabId}":{"kind":"text"}}`) }), {
        main: fileBoard(tabId),
      }),
      {},
    );
});

test('PDF page restoration clamps to the successfully loaded document without changing offsets', () => {
  const original: state.PdfReading = { kind: 'pdf', page: 8, zoom: 1.25, top: 180, left: 20 };
  assert.deepEqual(state.clampPdfReading(original, 3), { ...original, page: 3 });
  assert.deepEqual(state.clampPdfReading(original, 20), original);
  assert.deepEqual(state.clampPdfReading(original, 0), { ...original, page: 1 });
  assert.equal(original.page, 8);
});

test('serializing and restoring saves only current owners and cleaned reading metadata', () => {
  const layout = { width: 540, boards: { main: fileBoard(), side: fileBoard() } };
  const reading = {
    main: { a: { ...textReading(40), body: 'PRIVATE BODY' }, closed: textReading(10) },
    side: { a: { kind: 'pdf', page: 3, zoom: 1.25, top: 90, left: 4 } },
    removed: { a: textReading(80) },
  } as unknown as state.PreviewReadingSessions;
  const serialized = state.serializePreviewState(layout, reading);
  assert.equal(serialized.includes('PRIVATE BODY'), false);
  assert.ok(JSON.parse(serialized).reading, 'valid reading should be saved');
  assert.deepEqual(JSON.parse(serialized).reading, {
    version: 1,
    sessions: {
      main: { a: textReading(40) },
      side: { a: { kind: 'pdf', page: 3, zoom: 1.25, top: 90, left: 4 } },
    },
  });
  assert.deepEqual(
    state.readPreviewReading(serialized, layout.boards),
    JSON.parse(serialized).reading.sessions,
  );
  assert.deepEqual(restoreLayout(serialized), restoreLayout(JSON.stringify(layout)));
  assert.equal(state.serializePreviewState(layout, {}), JSON.stringify(layout));
  assert.equal(
    state.serializePreviewState(layout, { deleted: { a: textReading(2) } }),
    JSON.stringify(layout),
  );
});

function largeReading(character: string, length: number) {
  const board = emptyBoard();
  const reading: state.PreviewReadingSessions = { main: {} };
  for (let index = 0; index < 64; index++) {
    const id = `${index}-${character.repeat(length)}`;
    board.tabs.push({ id, kind: 'file', target: `C:/work/${index}.txt` });
    board.panes[0].tabs.push(id);
    reading.main[id] = textReading(index);
  }
  board.panes[0].active = board.tabs[0].id;
  return { layout: { width: 600, boards: { main: board } }, reading };
}

test('the 256 KiB reading limit counts UTF-8 bytes and preserves layout when exceeded', () => {
  const ascii = largeReading('a', 1400);
  const unicode = largeReading('文', 1400);
  const underLimitUnicode = largeReading('文', 1280);
  const metadata = JSON.stringify({ version: 1, sessions: unicode.reading });
  assert.ok(metadata.length < 256 * 1024);
  assert.ok(Buffer.byteLength(metadata, 'utf8') > 256 * 1024);
  assert.equal(
    Object.keys(state.readPreviewReading(stored(unicode.reading), unicode.layout.boards)).length,
    0,
  );
  for (const { layout, reading } of [ascii, underLimitUnicode]) {
    const metadata = { version: 1, sessions: reading };
    assert.ok(Buffer.byteLength(JSON.stringify(metadata), 'utf8') < 256 * 1024);
    assert.deepEqual(state.readPreviewReading(stored(reading), layout.boards), reading);
    assert.ok(
      JSON.parse(state.serializePreviewState(layout, reading)).reading,
      'reading within its quota should be saved',
    );
    assert.deepEqual(JSON.parse(state.serializePreviewState(layout, reading)).reading, metadata);
  }
  const serialized = state.serializePreviewState(unicode.layout, unicode.reading);
  assert.equal(serialized, JSON.stringify(unicode.layout));
  assert.deepEqual(restoreLayout(serialized), restoreLayout(JSON.stringify(unicode.layout)));
});

test('reading that crosses the total layout cap is removed before otherwise valid metadata is saved', () => {
  const layout = { width: 580, boards: {} as Record<string, ReturnType<typeof emptyBoard>> };
  for (let session = 0; session < 4; session++) {
    const board = emptyBoard();
    for (let index = 0; index < 64; index++) {
      const id = `tab-${index}`;
      board.tabs.push({
        id,
        kind: 'file',
        target: `C:/${'t'.repeat(4047)}`,
        root: `C:/${'r'.repeat(4047)}`,
      });
      board.panes[0].tabs.push(id);
    }
    board.panes[0].active = 'tab-0';
    layout.boards[`session-${session}`] = board;
  }
  let excess = JSON.stringify(layout).length - 1_999_750;
  assert.ok(excess > 0);
  for (const board of Object.values(layout.boards)) {
    for (const tab of board.tabs) {
      const trim = Math.min(excess, tab.root!.length - 3);
      tab.root = tab.root!.slice(0, tab.root!.length - trim);
      excess -= trim;
    }
  }
  const reading = { 'session-0': { 'tab-0': textReading(500) } };
  assert.ok(
    JSON.parse(state.serializePreviewState(layout, reading)).reading,
    'reading should fit just below the combined cap',
  );
  layout.boards['session-0'].tabs[0].root += 'r'.repeat(200);
  const baseline = JSON.stringify(layout);
  assert.equal(baseline.length, 1_999_950);
  assert.ok(
    JSON.stringify({ ...layout, reading: { version: 1, sessions: reading } }).length > 2_000_000,
  );
  const serialized = state.serializePreviewState(layout, reading);
  assert.equal(serialized, baseline);
  assert.equal(Object.keys(restoreLayout(serialized).boards).length, 4);
});
