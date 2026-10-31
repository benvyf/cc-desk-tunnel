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
  restoreLayout,
  fitFloat,
} from '../src/previewLayout.ts';

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
