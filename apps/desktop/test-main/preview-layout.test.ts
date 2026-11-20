import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emptyBoard,
  openTab,
  moveTab,
  splitPane,
  floatTab,
  dockPane,
  closeTab,
  closeTabs,
  paneTabsToClose,
  pinTab,
  previewTabLimit,
  previewTabsFull,
  restoreLayout,
  fitFloat,
  navigateFile,
  treeFolders,
  treeFolderLimit,
} from '../src/previewLayout.ts';

test('the tree’s open folders are restored with the layout, checked and bounded', () => {
  const saved = (folders: unknown) =>
    restoreLayout(JSON.stringify({ boards: { s: { ...emptyBoard(), tree: true, folders } } }))
      .boards.s;
  // Layouts saved before carry none.
  assert.equal(saved(undefined).folders, undefined);
  assert.equal(saved('src').folders, undefined);
  assert.deepEqual(
    saved([
      'src',
      'src/nested',
      'src',
      '../outside',
      'src/../..',
      '/etc',
      'c:/windows',
      'a\\b',
      '',
      'a//b',
      './a',
      7,
      'x'.repeat(1025),
    ]).folders,
    ['src', 'src/nested'],
  );
  const many = Array.from({ length: treeFolderLimit + 20 }, (_, i) => `folder${i}`);
  const kept = treeFolders(many);
  assert.equal(kept.length, treeFolderLimit);
  // The latest opened are kept.
  assert.equal(kept.at(-1), many.at(-1));
  assert.equal(kept[0], `folder20`);
  // And no more than 8000 characters of them.
  const long = treeFolders(Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(1000, 'x')));
  assert.equal(long.length, 8);
  assert.ok(long.at(-1)!.startsWith('19'));
});

test('file navigation keeps the tab, repeats explicit requests, and never replays after restore', () => {
  let board = openTab(emptyBoard(), {
    id: 'a',
    kind: 'file',
    target: 'C:\\work\\a.ts',
    wrap: true,
  });
  board = navigateFile(board, 'C:\\work\\a.ts', { line: 12, column: 3, id: 'first' });
  assert.equal(board.tabs[0].navigation?.line, 12);
  board = navigateFile(board, 'C:\\work\\a.ts', { line: 12, id: 'second' });
  assert.equal(board.tabs[0].id, 'a');
  assert.equal(board.tabs[0].navigation?.id, 'second');
  const restored = restoreLayout(JSON.stringify({ boards: { s: board } }));
  assert.equal(restored.boards.s.tabs[0].wrap, true);
  assert.equal(restored.boards.s.tabs[0].navigation, undefined);
  assert.equal(
    restoreLayout(
      JSON.stringify({ boards: { s: { ...board, tabs: [{ ...board.tabs[0], wrap: 'true' }] } } }),
    ).boards.s.tabs[0].wrap,
    false,
  );
});

test('deduplicates files, moves/reorders tabs and removes empty panes', () => {
  let board = openTab(emptyBoard(), { id: 'a', kind: 'file', target: 'C:\\work\\a.txt' });
  board = openTab(board, { id: 'b', kind: 'file', target: 'C:\\work\\b.txt' });
  board = openTab(board, { id: 'duplicate', kind: 'file', target: 'c:\\WORK\\a.txt' });
  assert.equal(board.tabs.length, 2);
  board = splitPane(board, board.focused, 'a', 'second');
  assert.equal(board.panes.length, 2);
  assert.deepEqual(board.panes[1].tabs, ['a']);
  board = moveTab(board, 'a', board.panes[0].id, 0);
  assert.equal(board.panes.length, 1);
  assert.deepEqual(board.panes[0].tabs, ['a', 'b']);
  board = closeTab(board, 'a');
  assert.equal(board.panes[0].active, 'b');
  assert.equal(board.tabs.length, 1);
});

test('floating and docking retain tab identity and bounds without duplicating content', () => {
  let board = openTab(emptyBoard(), { id: 'a', kind: 'file', target: 'C:\\a.pdf' });
  board = floatTab(board, 'a', 'floating');
  assert.equal(board.panes.find((p) => p.id === 'floating')?.floating?.width, 480);
  assert.equal(board.tabs.length, 1);
  board = dockPane(board, 'floating');
  assert.equal(board.panes.length, 1);
  assert.equal(board.panes[0].floating, undefined);
  assert.deepEqual(board.panes[0].tabs, ['a']);
});

test('restores only bounded layout metadata, discarding arbitrary content and remote addresses', () => {
  const input = {
    width: 5000,
    boards: {
      s: {
        tabs: [
          { id: 'a', kind: 'file', target: 'C:\\a.txt', text: 'SECRET' },
          { id: 'network', kind: 'file', target: '\\\\server\\share\\secret' },
          { id: 'web', kind: 'web', target: 'http://localhost:3000/' },
          { id: 'remote', kind: 'web', target: 'https://example.com/' },
        ],
        panes: [
          {
            id: 'pane',
            tabs: ['a', 'web', 'remote'],
            active: 'a',
            floating: { x: -400, y: 3, width: 9000, height: 10 },
          },
        ],
        focused: 'pane',
        expanded: true,
        tree: true,
      },
    },
  };
  const result = restoreLayout(JSON.stringify(input));
  assert.equal(result.width, 900);
  assert.deepEqual(
    result.boards.s.tabs.map((t) => t.id),
    ['a', 'web'],
  );
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(result.boards.s.panes[0].floating, { x: 0, y: 3, width: 1200, height: 180 });
  assert.deepEqual(restoreLayout('bad json').boards, {});
  assert.deepEqual(restoreLayout('"primitive"').boards, {});
});

test('floating rectangles fit their actual owner viewport after dragging or restoring', () => {
  assert.deepEqual(fitFloat({ x: 1100, y: 750, width: 480, height: 420 }, 1280, 900), {
    x: 800,
    y: 480,
    width: 480,
    height: 420,
  });
  assert.deepEqual(fitFloat({ x: 3000, y: 3000, width: 900, height: 800 }, 390, 500), {
    x: 0,
    y: 36,
    width: 390,
    height: 464,
  });
});

test('chat tabs restore as metadata without file access or website navigation', () => {
  const id = '8c6f7703-9633-4fbe-a68f-4d5e2ba7fbd0';
  const board = openTab(emptyBoard(), { id: 'tab', kind: 'chat', target: id, title: '引用追问' });
  const restored = restoreLayout(JSON.stringify({ width: 600, boards: { main: board } }));
  assert.equal(restored.boards.main.tabs[0].kind, 'chat');
  assert.equal(restored.boards.main.tabs[0].target, id);
  assert.equal(restored.boards.main.tabs[0].title, '引用追问');
  const invalid = restoreLayout(
    JSON.stringify({
      boards: { main: { ...board, tabs: [{ id: 'x', kind: 'chat', target: 'file:///secret' }] } },
    }),
  );
  assert.equal(invalid.boards.main.tabs.length, 0);
});

test('a temporary tab is taken over by the next temporary opening in its pane, and kept once pinned', () => {
  let board = openTab(emptyBoard(), { id: 'keep', kind: 'file', target: 'C:\\w\\keep.ts' });
  board = openTab(board, { id: 'a', kind: 'file', target: 'C:\\w\\a.ts', temporary: true });
  board = openTab(board, { id: 'b', kind: 'file', target: 'C:\\w\\b.ts', temporary: true });
  assert.deepEqual(
    board.tabs.map((t) => [t.id, t.temporary ?? false]),
    [
      ['keep', false],
      ['b', true],
    ],
  );
  assert.deepEqual(board.panes[0].tabs, ['keep', 'b']);
  assert.equal(board.panes[0].active, 'b');
  // Reopening the temporary tab's file temporarily leaves it temporary; opening it to keep pins it.
  board = openTab(board, { id: 'x', kind: 'file', target: 'c:\\W\\b.ts', temporary: true });
  assert.equal(board.tabs[1].temporary, true);
  board = openTab(board, { id: 'y', kind: 'file', target: 'C:\\w\\b.ts' });
  assert.equal(board.tabs[1].temporary, undefined);
  assert.equal(board.tabs.length, 2);
  board = openTab(board, { id: 'c', kind: 'file', target: 'C:\\w\\c.ts', temporary: true });
  assert.equal(board.tabs.length, 3);
  board = pinTab(board, 'c');
  assert.equal(board.tabs[2].temporary, undefined);
  board = openTab(board, { id: 'd', kind: 'file', target: 'C:\\w\\d.ts', temporary: true });
  assert.equal(board.tabs.length, 4);
});

test('moving a temporary tab to another pane keeps it; reordering in its pane does not', () => {
  let board = openTab(emptyBoard(), { id: 'keep', kind: 'file', target: 'C:\\w\\keep.ts' });
  board = openTab(board, { id: 'a', kind: 'file', target: 'C:\\w\\a.ts', temporary: true });
  board = moveTab(board, 'a', board.panes[0].id, 0);
  assert.equal(board.tabs[1].temporary, true);
  const split = splitPane(board, board.panes[0].id, 'a', 'second');
  assert.equal(split.tabs[1].temporary, undefined);
  const floated = floatTab(board, 'a', 'floating');
  assert.equal(floated.tabs[1].temporary, undefined);
  // A temporary tab opened in a floating pane is kept when the pane docks beside another temporary tab.
  let docked = openTab(
    { ...floated, focused: board.panes[0].id },
    { id: 'b', kind: 'file', target: 'C:\\w\\b.ts', temporary: true },
  );
  docked = { ...docked, focused: 'floating' };
  docked = openTab(docked, { id: 'c', kind: 'file', target: 'C:\\w\\c.ts', temporary: true });
  docked = dockPane(docked, 'floating');
  assert.deepEqual(
    docked.tabs.filter((t) => t.temporary).map((t) => t.id),
    ['b'],
  );
});

test('closing several tabs of a pane', () => {
  let board = emptyBoard();
  for (const id of ['a', 'b', 'c', 'd'])
    board = openTab(board, { id, kind: 'file', target: `C:\\w\\${id}.ts` });
  board = splitPane(board, board.panes[0].id, 'd', 'second');
  assert.deepEqual(paneTabsToClose(board, 'b', 'others'), ['a', 'c']);
  assert.deepEqual(paneTabsToClose(board, 'b', 'right'), ['c']);
  assert.deepEqual(paneTabsToClose(board, 'b', 'all'), ['a', 'b', 'c']);
  const closed = closeTabs(board, paneTabsToClose(board, 'b', 'all'));
  assert.deepEqual(
    closed.tabs.map((t) => t.id),
    ['d'],
  );
  assert.equal(closed.panes.length, 1);
  assert.equal(closeTabs(board, []), board);
});

test('a full board takes over a temporary tab, or opens nothing', () => {
  let board = emptyBoard();
  for (let i = 0; i < previewTabLimit; i++)
    board = openTab(board, { id: `t${i}`, kind: 'file', target: `C:\\w\\${i}.ts` });
  const more = { id: 'more', kind: 'file' as const, target: 'C:\\w\\more.ts' };
  assert.equal(previewTabsFull(board, more), true);
  assert.equal(previewTabsFull(board, { kind: 'file', target: 'c:\\W\\3.ts' }), false);
  assert.equal(openTab(board, more), board);
  board = {
    ...board,
    tabs: board.tabs.map((t) => (t.id === 't5' ? { ...t, temporary: true } : t)),
  };
  assert.equal(previewTabsFull(board, more), false);
  const opened = openTab(board, more);
  assert.equal(opened.tabs.length, previewTabLimit);
  assert.equal(opened.tabs[5].id, 'more');
  assert.equal(opened.tabs[5].temporary, undefined);
  assert.equal(opened.panes[0].tabs[5], 'more');
});

test('the temporary flag is saved and restored; layouts without it restore kept tabs', () => {
  let board = openTab(emptyBoard(), { id: 'a', kind: 'file', target: 'C:\\w\\a.ts' });
  board = openTab(board, { id: 'b', kind: 'file', target: 'C:\\w\\b.ts', temporary: true });
  board = openTab(board, {
    id: 'w',
    kind: 'web',
    target: 'http://localhost:5173/',
    temporary: true,
  });
  const restored = restoreLayout(JSON.stringify({ boards: { s: board } })).boards.s;
  assert.deepEqual(
    restored.tabs.map((t) => [t.id, t.temporary ?? false]),
    [
      ['a', false],
      ['w', true],
    ],
  );
  const old = restoreLayout(
    JSON.stringify({
      boards: {
        s: {
          ...board,
          tabs: [
            { id: 'a', kind: 'file', target: 'C:\\w\\a.ts' },
            { id: 'w', kind: 'web', target: 'http://localhost:5173/', temporary: 'yes' },
          ],
        },
      },
    }),
  ).boards.s;
  assert.equal(old.tabs.length, 2);
  assert.ok(old.tabs.every((t) => t.temporary === undefined));
});

test('a temporary opening replaces the temporary tab of the focused floating pane, not another pane’s', () => {
  let board = openTab(emptyBoard(), { id: 'keep', kind: 'file', target: 'C:\\w\\keep.ts' });
  board = openTab(board, { id: 'a', kind: 'file', target: 'C:\\w\\a.ts', temporary: true });
  board = floatTab(board, 'keep', 'floating');
  board = openTab(board, { id: 'b', kind: 'file', target: 'C:\\w\\b.ts', temporary: true });
  assert.deepEqual(board.panes.find((p) => p.id === 'floating')?.tabs, ['keep', 'b']);
  board = openTab(board, { id: 'c', kind: 'file', target: 'C:\\w\\c.ts', temporary: true });
  assert.deepEqual(board.panes.find((p) => p.id === 'floating')?.tabs, ['keep', 'c']);
  assert.deepEqual(board.panes.find((p) => p.id === 'primary')?.tabs, ['a']);
  assert.equal(board.focused, 'floating');
});

test('a full board takes over a temporary tab in a pane that is not focused', () => {
  let board = emptyBoard();
  for (let i = 0; i < previewTabLimit - 1; i++)
    board = openTab(board, { id: `t${i}`, kind: 'file', target: `C:\\w\\${i}.ts` });
  board = openTab(board, { id: 'temp', kind: 'file', target: 'C:\\w\\temp.ts', temporary: true });
  board = splitPane(board, 'primary', 'temp', 'second');
  board = {
    ...board,
    tabs: board.tabs.map((t) => (t.id === 'temp' ? { ...t, temporary: true } : t)),
  };
  board = { ...board, focused: 'primary' };
  const opened = openTab(board, {
    id: 'more',
    kind: 'file',
    target: 'C:\\w\\more.ts',
    temporary: true,
  });
  assert.equal(opened.tabs.length, previewTabLimit);
  assert.deepEqual(opened.panes.find((p) => p.id === 'second')?.tabs, ['more']);
  assert.equal(opened.focused, 'second');
});

test('opening the tab already shown as asked keeps the same board', () => {
  let board = openTab(emptyBoard(), { id: 'a', kind: 'file', target: 'C:\\w\\a.ts' });
  board = openTab(board, { id: 'b', kind: 'file', target: 'C:\\w\\b.ts', temporary: true });
  assert.equal(
    openTab(board, { id: 'x', kind: 'file', target: 'C:\\w\\b.ts', temporary: true }),
    board,
  );
  assert.notEqual(openTab(board, { id: 'x', kind: 'file', target: 'C:\\w\\b.ts' }), board);
  assert.notEqual(openTab(board, { id: 'x', kind: 'file', target: 'C:\\w\\a.ts' }), board);
  assert.equal(pinTab(board, 'a'), board);
});
