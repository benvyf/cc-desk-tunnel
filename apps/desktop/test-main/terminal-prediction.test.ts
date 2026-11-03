import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Terminal } from '@xterm/xterm';
import { PredictiveEchoAddon, type XtermTerminal } from 'xterm-zerolag-input';
import {
  classifyTerminalInput,
  createTerminalPrediction,
  type PredictionContext,
  type TerminalPrediction,
} from '../src/terminalPrediction.ts';

class Element extends EventTarget {
  listeners = new Map<
    string,
    { callback: EventListenerOrEventListenerObject; capture: boolean }[]
  >();
  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (!callback) return;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({
      callback,
      capture: typeof options === 'boolean' ? options : !!options?.capture,
    });
    this.listeners.set(type, listeners);
  }
  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (listener) => listener.callback !== callback || listener.capture !== capture,
      ),
    );
  }
  eventCallbacks(event: Event) {
    Object.defineProperty(event, 'target', { value: this, configurable: true });
    const ancestors: Element[] = [];
    for (let parent = this.parentElement; parent; parent = parent.parentElement)
      ancestors.push(parent);
    const callbacks: (() => void)[] = [];
    const collect = (target: Element, capture: boolean) => {
      for (const listener of [...(target.listeners.get(event.type) ?? [])]) {
        if (listener.capture !== capture) continue;
        callbacks.push(() => {
          if (typeof listener.callback === 'function') listener.callback.call(target, event);
          else listener.callback.handleEvent(event);
        });
      }
    };
    for (const ancestor of ancestors.reverse()) collect(ancestor, true);
    collect(this, true);
    collect(this, false);
    if (event.bubbles) for (const ancestor of ancestors.reverse()) collect(ancestor, false);
    return callbacks;
  }
  override dispatchEvent(event: Event) {
    for (const callback of this.eventCallbacks(event)) callback();
    return !event.defaultPrevented;
  }
  async dispatchWithCheckpoints(event: Event) {
    // Native browser event dispatch can drain microtasks between listener callbacks.
    for (const callback of this.eventCallbacks(event)) {
      callback();
      await Promise.resolve();
    }
  }
  nodeType = 1;
  children: Element[] = [];
  parentElement: Element | null = null;
  style = { cssText: '' };
  textContent = '';
  attrs = new Map<string, string>();
  ownerDocument!: DocumentStub;
  appendChild(child: Element) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  replaceChildren() {
    for (const child of [...this.children]) child.remove();
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
    this.parentElement = null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  contains(child: Element | null): boolean {
    return child === this || this.children.some((element) => element.contains(child));
  }
  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(selector === '.xterm-screen' && child.attrs.has('screen') ? [child] : []),
      ...(selector === '[data-predictive-echo]' && child.attrs.has('data-predictive-echo')
        ? [child]
        : []),
      ...(selector.includes('dialog') && child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  matches(selector: string) {
    return (
      selector.includes('dialog') &&
      this.attrs.get('role') === 'dialog' &&
      this.attrs.get('aria-modal') === 'true'
    );
  }
}

class DocumentStub extends EventTarget {
  body = new Element();
  defaultView: EventTarget & { MutationObserver: typeof MutationObserver };
  observers = new Set<MutationCallback>();
  queries = 0;
  activeElement: Element | null = null;
  visibilityState = 'visible';
  focused = true;
  constructor() {
    super();
    this.body.ownerDocument = this;
    const owner = this;
    this.defaultView = Object.assign(new EventTarget(), {
      MutationObserver: class {
        callback: MutationCallback;
        constructor(callback: MutationCallback) {
          this.callback = callback;
          owner.observers.add(callback);
        }
        observe() {}
        disconnect() {
          owner.observers.delete(this.callback);
        }
      } as unknown as typeof MutationObserver,
    });
  }
  createElement() {
    const element = new Element();
    element.ownerDocument = this;
    return element;
  }
  hasFocus() {
    return this.focused;
  }
  querySelector(selector: string) {
    this.queries++;
    return this.body.querySelector(selector);
  }
  mutate(record: Partial<MutationRecord>) {
    for (const callback of this.observers)
      callback([record as MutationRecord], null as unknown as MutationObserver);
  }
}

type Cell = { chars: string; width: number; inverse?: boolean };
const width = (text: string) => Array.from(text).reduce((sum, ch) => sum + (ch > '~' ? 2 : 1), 0);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(cols = 80, preboundXterm = false) {
  const document = new DocumentStub();
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  const host = document.createElement();
  const screen = document.createElement();
  screen.setAttribute('screen', '');
  const textarea = document.createElement();
  host.appendChild(screen);
  host.appendChild(textarea);
  document.body.appendChild(host);
  document.activeElement = textarea;
  const callbacks = new Map<string, Set<() => void>>();
  const on = (name: string, callback: () => void) => {
    let listeners = callbacks.get(name);
    if (!listeners) callbacks.set(name, (listeners = new Set()));
    listeners.add(callback);
    return { dispose: () => listeners.delete(callback) };
  };
  const lines = new Map<number, Cell[]>();
  const buffer = {
    type: 'alternate',
    baseY: 0,
    viewportY: 0,
    cursorX: 2,
    cursorY: 21,
    getLine(row: number) {
      const cells = lines.get(row) ?? [];
      return {
        getCell(col: number) {
          const cell = cells[col] ?? { chars: '', width: 1 };
          return {
            getChars: () => cell.chars,
            getWidth: () => cell.width,
            isInverse: () => !!cell.inverse,
          };
        },
        translateToString(trim = false, start = 0, end = cols) {
          const text = Array.from({ length: end - start }, (_, offset) => {
            const cell = cells[start + offset];
            return cell?.width === 0 ? '' : cell?.chars || ' ';
          }).join('');
          return trim ? text.trimEnd() : text;
        },
      };
    },
  };
  let addon: PredictiveEchoAddon | undefined;
  const keyCallbacks = new Set<(event: { key: string; domEvent: KeyboardEvent }) => void>();
  const emitKey = (key: string, domEvent: KeyboardEvent) => {
    for (const callback of keyCallbacks) callback({ key, domEvent });
  };
  const pasted: string[] = [];
  const terminal = {
    element: host,
    textarea,
    cols,
    rows: 24,
    options: { allowProposedApi: false },
    buffer: { active: buffer },
    dimensions: { css: { cell: { width: 8, height: 16 } } },
    onWriteParsed: (callback: () => void) => on('parsed', callback),
    onScroll: (callback: () => void) => on('scroll', callback),
    onResize: (callback: () => void) => on('resize', callback),
    onKey(callback: (event: { key: string; domEvent: KeyboardEvent }) => void) {
      keyCallbacks.add(callback);
      return { dispose: () => keyCallbacks.delete(callback) };
    },
    loadAddon(value: PredictiveEchoAddon) {
      addon = value;
      value.activate(terminal as unknown as XtermTerminal);
    },
    paste(text: string) {
      pasted.push(text);
      prediction.beforeInput(text);
    },
  };
  let context: PredictionContext = {
    running: true,
    visible: true,
    connected: true,
    closing: false,
  };
  const line = (row: number, text: string) => {
    const cells: Cell[] = [];
    for (const ch of text) {
      const wide = ch !== '❯' && ch !== '─' && ch > '~' && ch !== '\u00a0';
      cells.push({ chars: ch, width: wide ? 2 : 1 });
      if (wide) cells.push({ chars: '', width: 0 });
    }
    lines.set(row, cells);
  };
  const composer = (text = '') => {
    const row = terminal.rows - 3;
    line(row - 1, '─'.repeat(cols));
    line(row, `❯\u00a0${text}`);
    buffer.cursorX = 2 + width(text);
    buffer.cursorY = row;
    lines.get(row)![buffer.cursorX] = { chars: ' ', width: 1, inverse: true };
    line(row + 1, '─'.repeat(cols));
    // This footer's symbols use terminal cells differently from the text fixture helper.
    lines.set(
      row + 2,
      Array.from('  ⏸ manual mode on', (chars) => ({ chars, width: 1 })),
    );
  };
  composer();
  if (preboundXterm) {
    // Match terminal.open(): xterm's target capture handler predates the adapter.
    textarea.addEventListener(
      'keydown',
      (event) => {
        const key = (event as KeyboardEvent).key;
        const data = key === 'Backspace' ? '\x7f' : key;
        emitKey(data, event as KeyboardEvent);
        prediction.beforeInput(data);
      },
      true,
    );
  }
  // xterm registers its compositionend bubble listener during terminal.open().
  textarea.addEventListener('compositionend', (event) => {
    const text = (event as Event & { commitText?: string }).commitText;
    if (text) setTimeout(() => prediction.beforeInput(text), 0);
  });
  const prediction = createTerminalPrediction(
    terminal as unknown as Terminal,
    host as unknown as HTMLElement,
    () => context,
  );
  cleanups.push(() => prediction.dispose());
  const event = (target: EventTarget, name: string, properties: Record<string, unknown> = {}) => {
    const value = new Event(name);
    Object.assign(value, properties);
    target.dispatchEvent(value);
    return value;
  };
  const key = (data: string, key = data) => {
    const domEvent = event(textarea, 'keydown', {
      key,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
    });
    if (!preboundXterm) {
      emitKey(data, domEvent as KeyboardEvent);
      prediction.beforeInput(data);
    }
  };
  const parsed = async () => {
    for (const callback of [...(callbacks.get('parsed') ?? [])]) callback();
    await Promise.resolve();
  };
  const overlay = () =>
    screen
      .querySelectorAll('[data-predictive-echo]')
      .flatMap((el) => el.children)
      .map((el) => el.textContent)
      .join('');
  return {
    prediction,
    terminal,
    buffer,
    lines,
    document,
    host,
    textarea,
    screen,
    key,
    event,
    parsed,
    composer,
    line,
    overlay,
    pasted,
    callbacks,
    keyCallbacks,
    emitKey,
    addon: () => addon!,
    context: (patch: Partial<PredictionContext>) => {
      context = { ...context, ...patch };
    },
  };
}

test('classifies only verified characters with an explicit keyboard or IME source', () => {
  for (const text of [
    'a',
    ' ',
    '中',
    '，',
    '。',
    '！',
    '？',
    '：',
    '；',
    '（',
    '）',
    '【',
    '】',
    '《',
    '》',
    '、',
  ]) {
    assert.deepEqual(classifyTerminalInput(text, 'key'), { kind: 'text', text });
  }
  assert.deepEqual(classifyTerminalInput('中文，test', 'ime'), {
    kind: 'text',
    text: '中文，test',
  });
  assert.deepEqual(classifyTerminalInput('\x7f', 'key'), { kind: 'backspace' });
  for (const text of [
    '',
    'ab',
    '😀',
    'é',
    'e\u0301',
    '/',
    '@',
    '\x1b[A',
    '\r',
    '\t',
    '\x03',
    '\n',
  ]) {
    assert.deepEqual(classifyTerminalInput(text, 'key'), { kind: 'clear' }, JSON.stringify(text));
  }
  for (const origin of ['paste', 'unknown'] as const) {
    assert.deepEqual(classifyTerminalInput('a', origin), { kind: 'clear' });
  }
  assert.deepEqual(classifyTerminalInput('中'.repeat(32), 'ime'), {
    kind: 'text',
    text: '中'.repeat(32),
  });
  assert.deepEqual(classifyTerminalInput('中'.repeat(33), 'ime'), { kind: 'clear' });
});

test('deleting echoed text recovers after the latest real replacement arrives', async () => {
  const f = fixture();
  f.composer('a');
  f.prediction.setEnabled(true);
  f.key('\x7f', 'Backspace');
  f.key('b');
  assert.equal(f.overlay(), '');
  f.composer('b');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), 'c');
});

test('the first valid composer is usable after startup display invalidation', async () => {
  const f = fixture();
  f.buffer.type = 'normal';
  f.prediction.setEnabled(true);
  f.prediction.clear();
  await f.parsed();
  f.buffer.type = 'alternate';
  f.composer();
  await f.parsed();
  f.key('a');
  assert.equal(f.overlay(), 'a');
});

test('disabled startup protocol replies do not lock the first real composer', async () => {
  const f = fixture();
  f.buffer.type = 'normal';
  f.prediction.beforeInput('\x1b[?1;2c');
  f.buffer.type = 'alternate';
  f.composer();
  await f.parsed();
  f.prediction.setEnabled(true);
  f.key('a');
  assert.equal(f.overlay(), 'a');
});

test('an unpredicted wide character at the edge blocks following stale-cursor predictions', () => {
  const f = fixture(20);
  f.composer('a'.repeat(13));
  f.prediction.setEnabled(true);
  f.key('中');
  assert.equal(f.overlay(), '');
  f.key('x');
  assert.equal(f.overlay(), '');
});

test('automatic focus and device-attribute replies are not treated as editor changes', () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  for (const reply of ['\x1b[I', '\x1b[O', '\x1b[?1;2c']) f.prediction.beforeInput(reply);
  f.key('a');
  assert.equal(f.overlay(), 'a');
});

test('is off by default and restores the per-terminal proposed API option', async () => {
  const f = fixture();
  f.key('a');
  assert.equal(f.screen.children.length, 0);
  f.composer('a');
  await f.parsed();
  f.prediction.setEnabled(true);
  assert.equal(f.terminal.options.allowProposedApi, true);
  f.key('a');
  assert.equal(f.overlay(), 'a');
  assert.equal(f.buffer.getLine(21).translateToString(false, 0, 3), '❯\u00a0a');
  f.prediction.setEnabled(false);
  assert.equal(f.overlay(), '');
  assert.equal(f.screen.children.length, 0);
  assert.equal(f.terminal.options.allowProposedApi, false);
  f.prediction.dispose();
  f.prediction.dispose();
});

test('toggle and disabled inputs cannot resume prediction ahead of earlier wire echoes', async () => {
  for (const mode of ['toggle', 'initially-off', 'disabled-input'] as const) {
    const f = fixture();
    if (mode !== 'initially-off') f.prediction.setEnabled(true);
    f.key('a');
    f.prediction.setEnabled(false);
    if (mode === 'disabled-input') f.key('x');
    f.prediction.setEnabled(true);
    f.key('b');
    assert.equal(f.overlay(), '', mode);
    f.composer('a');
    await f.parsed();
    f.key('c');
    assert.equal(f.overlay(), '', `${mode}: older a cannot unlock while b is in flight`);
    f.composer(mode === 'disabled-input' ? 'axbc' : 'abc');
    await f.parsed();
    f.key('d');
    assert.equal(f.overlay(), 'd', mode);
  }
});

test('recognizes just the strict composer and ignores ordinary conversation history', async () => {
  const f = fixture();
  f.line(0, 'Different model and project; prior answer with ❯ and /commands.');
  f.prediction.setEnabled(true);
  f.key('a');
  assert.equal(f.overlay(), 'a');
  f.composer('a');
  await f.parsed();
  assert.equal(f.overlay(), '');
  f.key('中');
  assert.equal(f.overlay(), '中');
});

test('modifier keys alone do not create a wire-edit barrier before printable typing', () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.event(f.textarea, 'keydown', { key: 'Shift', shiftKey: true });
  f.key('A');
  assert.equal(f.overlay(), 'A');
  f.event(f.textarea, 'keydown', { key: 'Shift' });
  f.key('B');
  assert.equal(f.overlay(), 'AB');
});

test('empty xterm protocol replies do not hold the composer before its first real key', () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  for (let i = 0; i < 6; i++) f.prediction.beforeInput('');
  f.key('a');
  assert.equal(f.overlay(), 'a');
});

test('onKey registered after terminal.open still attributes the first keyboard input', () => {
  const f = fixture(80, true);
  f.prediction.setEnabled(true);
  f.key('a');
  assert.equal(f.overlay(), 'a');
});

test('native listener microtask checkpoints cannot expire the onKey ticket before onData', async () => {
  const f = fixture(80, true);
  f.prediction.setEnabled(true);
  const event = Object.assign(new Event('keydown'), { key: 'a' });
  await f.textarea.dispatchWithCheckpoints(event);
  assert.equal(f.overlay(), 'a');
});

test('native compositionend checkpoints preserve xterm delayed commit before ticket expiry', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.event(f.textarea, 'compositionstart');
  const event = Object.assign(new Event('compositionend'), { data: '中文', commitText: '中文' });
  await f.textarea.dispatchWithCheckpoints(event);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.overlay(), '中文');
});

test('onKey attributes the actual wire key and expires unused source tickets', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.emitKey(
    'A',
    Object.assign(new Event('keypress'), { key: 'a', shiftKey: true }) as KeyboardEvent,
  );
  f.prediction.beforeInput('A');
  assert.equal(f.overlay(), 'A');
  f.composer('A');
  await f.parsed();
  f.emitKey('b', Object.assign(new Event('keydown'), { key: 'b' }) as KeyboardEvent);
  await Promise.resolve();
  f.prediction.beforeInput('b');
  assert.equal(f.overlay(), '');
});

test('a keydown on another host child cannot grant an onKey source ticket', () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  const other = f.document.createElement();
  f.host.appendChild(other);
  f.event(other, 'keydown', { key: 'a' });
  f.prediction.beforeInput('a');
  assert.equal(f.overlay(), '');
});

test('rejects unknown, menu, login, approval, interior, multiline and scrollback shapes', () => {
  const corruptions = [
    (f: ReturnType<typeof fixture>) => f.line(20, 'Login to continue'),
    (f: ReturnType<typeof fixture>) => f.line(22, 'Allow this tool?'),
    (f: ReturnType<typeof fixture>) => f.line(23, '  ⏵⏵ accept edits on'),
    (f: ReturnType<typeof fixture>) => f.line(21, '> approval'),
    (f: ReturnType<typeof fixture>) => {
      f.buffer.cursorY--;
    },
    (f: ReturnType<typeof fixture>) => {
      f.buffer.viewportY = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.lines.get(21)![2] = { chars: ' ', width: 1 };
    },
    (f: ReturnType<typeof fixture>) => {
      f.lines.get(21)![4] = { chars: 'x', width: 1 };
    },
    (f: ReturnType<typeof fixture>) => f.composer('/'),
    (f: ReturnType<typeof fixture>) => f.composer('@'),
  ];
  for (const corrupt of corruptions) {
    const f = fixture();
    f.prediction.setEnabled(true);
    corrupt(f);
    f.key('a');
    assert.equal(f.overlay(), '', corrupt.toString());
  }
});

test('a control edit stays blocked through background refresh until the real editor changes', async () => {
  const f = fixture();
  f.composer('old');
  f.prediction.setEnabled(true);
  f.key('\x1b[D', 'ArrowLeft');
  f.line(0, 'spinner changed');
  await f.parsed();
  f.key('a');
  assert.equal(f.overlay(), '');
  f.composer('olda');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), '');
  f.composer('oldab');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), 'c');
});

test('echoes queued before a control edit cannot unlock its editor barrier', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.key('b');
  f.key('\x1b[D', 'ArrowLeft');
  await f.parsed();
  f.key('x');
  assert.equal(f.overlay(), '');
  for (const prefix of ['a', 'ab']) {
    f.composer(prefix);
    await f.parsed();
    f.key('y');
    assert.equal(f.overlay(), '', prefix);
  }
  f.composer('abxyy');
  await f.parsed();
  f.key('z');
  assert.equal(f.overlay(), '');
  f.composer('abxyyz');
  await f.parsed();
  f.key('q');
  assert.equal(f.overlay(), 'q');
});

test('a locally removed pending character remains excluded from control barrier recovery', async () => {
  for (const partialAck of [false, true]) {
    const f = fixture();
    f.prediction.setEnabled(true);
    f.key('a');
    f.key('b');
    if (partialAck) {
      f.composer('a');
      await f.parsed();
    }
    f.key('\x7f', 'Backspace');
    f.key('\x1b[D', 'ArrowLeft');
    f.composer('ab');
    await f.parsed();
    f.key('z');
    assert.equal(f.overlay(), '', `partialAck=${partialAck}`);
    f.composer('az');
    await f.parsed();
    f.key('q');
    assert.equal(f.overlay(), '');
    f.composer('azq');
    await f.parsed();
    f.key('r');
    assert.equal(f.overlay(), 'r');
  }
});

test('late-echo candidates stay bounded across repeated type/delete without acknowledgements', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  for (let i = 0; i < 32; i++) {
    f.key(String.fromCodePoint(0x4e00 + i));
    f.key('\x7f', 'Backspace');
  }
  f.key('Z');
  assert.equal(f.overlay(), '');
  f.composer('一');
  await f.parsed();
  f.key('q');
  assert.equal(f.overlay(), '');
  f.composer('Zq');
  await f.parsed();
  f.key('r');
  assert.equal(f.overlay(), 'r');
});

test('Enter recovers on a real empty composer but an empty Enter needs a real edit', async () => {
  const f = fixture();
  f.composer('send this');
  f.prediction.setEnabled(true);
  f.key('\r', 'Enter');
  await f.parsed();
  f.key('x');
  assert.equal(f.overlay(), '');
  f.composer();
  await f.parsed();
  // The x typed after Enter is still in flight; a blank submission frame cannot acknowledge it.
  f.composer('x');
  await f.parsed();
  f.key('y');
  assert.equal(f.overlay(), 'y');
  f.composer('xy');
  await f.parsed();
  f.composer();
  await f.parsed();
  f.key('\r', 'Enter');
  await f.parsed();
  f.key('z');
  assert.equal(f.overlay(), '');
});

test('source tickets cannot turn unknown data or a single-character paste into typing', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.event(f.textarea, 'keydown', { key: 'a' });
  await Promise.resolve();
  f.prediction.beforeInput('a');
  assert.equal(f.overlay(), '');
  f.composer('a');
  await f.parsed();
  f.prediction.paste('b');
  assert.deepEqual(f.pasted, ['b']);
  assert.equal(f.overlay(), '');
  f.composer('ab');
  await f.parsed();
  f.event(f.textarea, 'paste');
  f.prediction.beforeInput('中');
  assert.equal(f.overlay(), '');
});

test('IME predicts only the asynchronous xterm commit and never sends composition event data', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.event(f.textarea, 'compositionstart');
  f.event(f.textarea, 'keydown', { key: 'Process', isComposing: true });
  f.event(f.textarea, 'compositionend', { data: 'unreliable event data', commitText: '中文' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.overlay(), '中文');
  assert.deepEqual(f.pasted, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.composer('中文');
  await f.parsed();
  f.prediction.beforeInput('a');
  assert.equal(f.overlay(), '');
});

test('pending backspace is immediate while deleting echoed text blocks stale anchoring', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.key('中');
  f.key('\x7f', 'Backspace');
  assert.equal(f.overlay(), 'a');
  f.composer('a');
  await f.parsed();
  f.key('\x7f', 'Backspace');
  f.key('b');
  assert.equal(f.overlay(), '');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), '');
  f.composer('bc');
  await f.parsed();
  f.key('d');
  assert.equal(f.overlay(), 'd');
});

test('pending backspace holds retyping through a late pre-deletion echo without another control', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.key('b');
  f.key('\x7f', 'Backspace');
  assert.equal(f.overlay(), 'a');
  f.composer('ab');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), '');
  f.composer('ac');
  await f.parsed();
  f.key('d');
  assert.equal(f.overlay(), 'd');
});

test('preflights pending widths before drawing another character', () => {
  const f = fixture(24);
  f.composer('a'.repeat(14));
  f.prediction.setEnabled(true);
  f.key('中');
  f.key('文');
  assert.equal(f.overlay(), '中文');
  f.key('a');
  assert.equal(f.overlay(), '');
});

test('preflights a whole IME group without disabling a healthy addon at the edge', async () => {
  const f = fixture(24);
  f.composer('a'.repeat(17));
  f.prediction.setEnabled(true);
  f.event(f.textarea, 'compositionstart');
  f.event(f.textarea, 'compositionend', { data: '中文' });
  f.prediction.beforeInput('中文');
  assert.equal(f.overlay(), '');
  f.key('\r', 'Enter');
  f.composer();
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), 'b');
});

test('an unsolicited compositionend cannot grant an IME origin ticket', () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.event(f.textarea, 'compositionend', { data: '中文' });
  f.prediction.beforeInput('中文');
  assert.equal(f.overlay(), '');
});

test('partial acknowledgements release only confirmed widths from the pending group', async () => {
  const f = fixture(24);
  f.composer('a'.repeat(12));
  f.prediction.setEnabled(true);
  f.key('中');
  f.key('文');
  assert.equal(f.overlay(), '中文');
  f.composer('a'.repeat(12) + '中');
  await f.parsed();
  assert.equal(f.overlay(), '文');
  f.key('b');
  f.key('c');
  assert.equal(f.overlay(), '文bc');
  f.key('d');
  assert.equal(f.overlay(), '');
});

test('a dropped run cannot re-anchor until a parsed edit changes the real composer', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  // Simulate the addon's public expiry/mismatch result; it is not an acknowledgement.
  f.addon().clearPredictions();
  f.key('b');
  assert.equal(f.overlay(), '');
  f.line(0, 'unrelated spinner');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), '');
  f.composer('abc');
  await f.parsed();
  f.key('d');
  assert.equal(f.overlay(), 'd');
});

test('modal changes clear the overlay but prediction DOM changes do not scan the document', () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  const queries = f.document.queries;
  const span = f.screen.querySelector('[data-predictive-echo]')!.children[0];
  f.document.mutate({
    type: 'childList',
    addedNodes: [span] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
  });
  assert.equal(f.document.queries, queries);
  const modal = f.document.createElement();
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  f.document.body.appendChild(modal);
  f.document.mutate({
    type: 'childList',
    addedNodes: [modal] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
  });
  assert.equal(f.overlay(), '');
  f.prediction.dispose();
  assert.equal(f.document.observers.size, 0);
});

test('caps a prediction run at 32 codepoints and clears the whole run on overflow', () => {
  const f = fixture(100);
  f.prediction.setEnabled(true);
  for (let i = 0; i < 32; i++) f.key('a');
  assert.equal(f.overlay(), 'a'.repeat(32));
  f.key('b');
  assert.equal(f.overlay(), '');
});

test('scroll, resize, refresh, blur and inactive contexts remove spans immediately', () => {
  const actions = [
    (f: ReturnType<typeof fixture>) => {
      for (const cb of f.callbacks.get('scroll') ?? []) cb();
    },
    (f: ReturnType<typeof fixture>) => {
      for (const cb of f.callbacks.get('resize') ?? []) cb();
    },
    (f: ReturnType<typeof fixture>) => f.prediction.refresh(),
    (f: ReturnType<typeof fixture>) => f.event(f.document.defaultView, 'blur'),
    (f: ReturnType<typeof fixture>) => f.event(f.textarea, 'blur'),
    (f: ReturnType<typeof fixture>) => {
      f.document.visibilityState = 'hidden';
      f.event(f.document, 'visibilitychange');
    },
    (f: ReturnType<typeof fixture>) => {
      f.document.activeElement = f.document.body;
      f.event(f.document, 'focusin');
    },
    (f: ReturnType<typeof fixture>) => {
      f.context({ connected: false });
      f.key('b');
    },
    (f: ReturnType<typeof fixture>) => {
      f.context({ running: false });
      f.key('b');
    },
    (f: ReturnType<typeof fixture>) => {
      f.context({ visible: false });
      f.key('b');
    },
    (f: ReturnType<typeof fixture>) => {
      f.context({ closing: true });
      f.key('b');
    },
  ];
  for (const action of actions) {
    const f = fixture();
    f.prediction.setEnabled(true);
    f.key('a');
    assert.equal(f.overlay(), 'a');
    action(f);
    assert.equal(f.overlay(), '', action.toString());
  }
});

test('initialization or drawing faults stop this instance and clean up owned overlays', () => {
  const init = fixture();
  init.terminal.loadAddon = (addon) => {
    addon.activate(init.terminal as unknown as XtermTerminal);
    throw new Error('activation fault');
  };
  assert.doesNotThrow(() => init.prediction.setEnabled(true));
  assert.equal(init.screen.children.length, 0);
  assert.equal(init.terminal.options.allowProposedApi, false);
  const draw = fixture();
  draw.prediction.setEnabled(true);
  draw.key('a');
  draw.addon().predictChar = () => {
    throw new Error('draw fault');
  };
  assert.doesNotThrow(() => draw.key('b'));
  assert.equal(draw.screen.children.length, 0);
  assert.equal(draw.terminal.options.allowProposedApi, false);
  draw.prediction.setEnabled(false);
  draw.prediction.setEnabled(true);
  draw.key('c');
  assert.equal(draw.screen.children.length, 0);
});

test('dispose releases parsed/resize listeners and prevents subsequent use', () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.prediction.dispose();
  assert.equal(f.overlay(), '');
  assert.equal(f.keyCallbacks.size, 0);
  assert.equal(
    [...f.callbacks.values()].reduce((sum, listeners) => sum + listeners.size, 0),
    0,
  );
  f.key('b');
  f.prediction.setEnabled(true);
  assert.equal(f.screen.children.length, 0);
});

const control = (f: ReturnType<typeof fixture>, data: string, key: string) => {
  f.emitKey(data, Object.assign(new Event('keydown'), { key, ctrlKey: true }) as KeyboardEvent);
  f.prediction.beforeInput(data);
};

test('Ctrl+U recovers after ordinary echo', async () => {
  const f = fixture();
  f.composer('old');
  f.prediction.setEnabled(true);
  control(f, '\x15', 'u');
  f.composer();
  await f.parsed();
  f.key('a');
  f.composer('a');
  await f.parsed();
  f.key('b');
  f.composer('ab');
  await f.parsed();
  f.prediction.setEnabled(false);
  f.prediction.setEnabled(true);
  f.key('c');
  assert.equal(f.overlay(), 'c');
});

test('Ctrl+W recovers after ordinary echo', async () => {
  const f = fixture();
  f.composer('one two');
  f.prediction.setEnabled(true);
  control(f, '\x17', 'w');
  f.composer('one ');
  await f.parsed();
  f.key('a');
  f.composer('one a');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), 'b');
});

test('history recalled into ordinary end-of-line text recovers after ordinary echo', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('\x1b[A', 'ArrowUp');
  f.composer('recalled');
  await f.parsed();
  f.key('a');
  f.composer('recalleda');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), 'b');
});

test('long single-line ASCII paste recovers at echoed composer', async () => {
  const f = fixture(120);
  f.prediction.setEnabled(true);
  const text = 'a'.repeat(33);
  f.prediction.paste(text);
  f.composer(text);
  await f.parsed();
  f.key('b');
  f.composer(text + 'b');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), 'c');
});

test('over 65 suppressed edits remain recoverable after Enter and toggle', async () => {
  const f = fixture(120);
  f.composer('old');
  f.prediction.setEnabled(true);
  control(f, '\x15', 'u');
  f.composer();
  await f.parsed();
  let text = '';
  for (let i = 0; i < 66; i++) {
    f.key('a');
    text += 'a';
    f.composer(text);
    await f.parsed();
  }
  f.key('\r', 'Enter');
  f.composer();
  await f.parsed();
  f.prediction.setEnabled(false);
  f.prediction.setEnabled(true);
  f.key('z');
  assert.equal(f.overlay(), 'z');
});

test('a real TTL expiry followed by delayed successful echo does not double-count pending', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  assert.equal(f.overlay(), 'a');
  await new Promise((resolve) => setTimeout(resolve, 830));
  assert.equal(f.addon().state.outstanding, 0);
  f.composer('a');
  await f.parsed();
  f.key('b');
  f.composer('ab');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), 'c');
});

test('consecutive no-op controls require enough distinct ordinary echoes to resolve both', async () => {
  const f = fixture();
  f.composer('old');
  f.prediction.setEnabled(true);
  control(f, '\x01', 'a');
  control(f, '\x05', 'e');
  f.composer('old');
  await f.parsed();
  f.key('a');
  f.composer('olda');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), '');
  f.composer('oldab');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), '');
  f.composer('oldabc');
  await f.parsed();
  f.key('d');
  assert.equal(f.overlay(), 'd');
});

test('cancelled composition without pending leaves prediction usable', () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.event(f.textarea, 'compositionstart');
  f.event(f.textarea, 'compositionend', { data: '' });
  f.key('a');
  assert.equal(f.overlay(), 'a');
});

test('no-op Tab cannot use an unchanged or ambiguous first echo as acknowledgement', async () => {
  const f = fixture();
  f.composer('old');
  f.prediction.setEnabled(true);
  f.key('\t', 'Tab');
  f.composer('old');
  await f.parsed();
  f.key('a');
  f.composer('olda');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), '');
  f.composer('oldab');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), 'c');
});

test('parsed intermediate redraw preserves the sent target until the complete echo', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  // A split redraw ends its first parsed write while the cursor is on the top border.
  f.buffer.cursorY = 20;
  await f.parsed();
  // The next write completes the supported single-line composer including the real a echo.
  f.composer('a');
  await f.parsed();
  f.key('b');
  f.composer('ab');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), 'c');
});

test('Ctrl+U hold recovers on Enter before state budget overflow', async () => {
  const f = fixture();
  f.composer('old');
  f.prediction.setEnabled(true);
  control(f, '\x15', 'u');
  f.composer();
  await f.parsed();
  f.key('a');
  f.composer('a');
  await f.parsed();
  f.key('\r', 'Enter');
  f.composer();
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), 'b');
});

test('acknowledged pending prediction can resume after cancellation', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.event(f.textarea, 'compositionstart');
  f.event(f.textarea, 'compositionend', { data: '' });
  f.composer('a');
  await f.parsed();
  f.key('b');
  f.composer('ab');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), 'c');
});

test('bracketed paste is not predicted and recovers after its complete echo', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.event(f.textarea, 'paste');
  f.prediction.beforeInput('\x1b[200~x\x1b[201~');
  assert.equal(f.overlay(), '');
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.composer('x');
  await f.parsed();
  f.key('a');
  assert.equal(f.overlay(), 'a');
});

test('unknown control followed by queued text rejects earlier predicted echoes', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.key('b');
  control(f, '\x15', 'u');
  f.key('x');
  for (const text of ['a', 'ab', '']) {
    f.composer(text);
    await f.parsed();
    assert.equal(f.overlay(), '');
  }
  f.key('y');
  assert.equal(f.overlay(), '');
  f.composer('xy');
  await f.parsed();
  f.key('z');
  assert.equal(f.overlay(), '');
  f.composer('xyz');
  await f.parsed();
  f.key('q');
  assert.equal(f.overlay(), 'q');
});

test('history budget exhaustion keeps a healthy renderer and recovers on a new verified column', async () => {
  const f = fixture(120);
  f.prediction.setEnabled(true);
  // Keep sending without any echo, forcing the suppressed-history budget to fill.
  for (let i = 0; i < 90; i++) f.key('a');
  assert.equal(f.screen.children.length, 1);
  assert.equal(f.overlay(), '');
  // An overflowed old prefix must still be excluded after a control edit.
  control(f, '\x15', 'u');
  f.composer('a'.repeat(70));
  await f.parsed();
  f.key('x');
  assert.equal(f.overlay(), '');
  f.composer('x');
  await f.parsed();
  f.key('y');
  assert.equal(f.overlay(), '');
  f.composer('xy');
  await f.parsed();
  f.key('z');
  assert.equal(f.overlay(), 'z');
});

test('fully echoed disabled typing does not reuse an unloaded prediction target', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.prediction.setEnabled(false);
  let text = '';
  for (const char of 'abc') {
    if (char !== 'a') f.key(char);
    text += char;
    f.composer(text);
    await f.parsed();
  }
  f.prediction.setEnabled(true);
  f.key('d');
  assert.equal(f.overlay(), 'd');
});

for (const mode of ['queued-typing', 'large-paste'] as const) {
  test(`untrackable ${mode} stays suspended without unloading a healthy renderer`, async () => {
    const f = fixture(120);
    f.composer('old');
    f.prediction.setEnabled(true);
    control(f, '\x15', 'u');
    if (mode === 'queued-typing') {
      for (let i = 0; i < 401; i++) f.key('a');
    } else f.prediction.paste('a'.repeat(413));
    f.composer('a');
    await f.parsed();
    f.key('z');
    assert.equal(f.overlay(), '');
    f.key('\r', 'Enter');
    f.composer();
    await f.parsed();
    f.key('b');
    assert.equal(f.overlay(), '');
    f.composer('b');
    await f.parsed();
    f.key('c');
    assert.equal(f.overlay(), '');
    f.prediction.setEnabled(false);
    f.prediction.setEnabled(true);
    assert.equal(f.screen.children.length, 1);
    f.key('d');
    assert.equal(f.overlay(), '');
    const fresh = fixture();
    fresh.prediction.setEnabled(true);
    fresh.key('z');
    assert.equal(fresh.overlay(), 'z');
  });
}

test('a second unknown control cannot forget earlier suppressed text echoes', async () => {
  const f = fixture();
  f.composer('old');
  f.prediction.setEnabled(true);
  control(f, '\x15', 'u');
  f.key('x');
  f.key('y');
  control(f, '\x17', 'w');
  for (const text of ['x', 'xy']) {
    f.composer(text);
    await f.parsed();
  }
  f.key('z');
  assert.equal(f.overlay(), '');
  f.composer('z');
  await f.parsed();
  f.key('q');
  assert.equal(f.overlay(), '');
  f.composer('zq');
  await f.parsed();
  f.key('r');
  assert.equal(f.overlay(), 'r');
});

test('repeated ordinary suffixes remain ambiguous until a distinct echo resolves them', async () => {
  const f = fixture();
  f.composer('old');
  f.prediction.setEnabled(true);
  control(f, '\x15', 'u');
  for (let i = 0; i < 6; i++) f.key('a');
  f.composer('aaaaaa');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), '');
  f.composer('aaaaaab');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), 'c');
});

test('a normal addon refusal suspends prediction until echo without disabling the renderer', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  const predictChar = f.addon().predictChar.bind(f.addon());
  f.addon().predictChar = () => false;
  f.key('a');
  assert.equal(f.screen.children.length, 1);
  assert.equal(f.overlay(), '');
  f.addon().predictChar = predictChar;
  f.composer('a');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), 'b');
});

test('resizing moves the supported composer without losing its in-flight recovery target', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.terminal.rows = 30;
  for (const callback of f.callbacks.get('resize') ?? []) callback();
  f.composer('a');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), 'b');
});

test('an unknown control cannot discard uncertainty from an oversized paste', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.prediction.paste('a'.repeat(413));
  control(f, '\x15', 'u');
  f.composer('a');
  await f.parsed();
  f.key('z');
  assert.equal(f.overlay(), '');
  f.key('\r', 'Enter');
  f.composer();
  await f.parsed();
  f.key('b');
  f.composer('b');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), '');
  assert.equal(f.screen.children.length, 1);
});

test('a control after a short paste excludes valid partial composer echoes', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.prediction.paste('abc');
  control(f, '\x15', 'u');
  for (const text of ['a', 'ab', 'abc']) {
    f.composer(text);
    await f.parsed();
  }
  f.key('z');
  assert.equal(f.overlay(), '');
  f.composer('z');
  await f.parsed();
  f.key('q');
  assert.equal(f.overlay(), '');
  f.composer('zq');
  await f.parsed();
  f.key('r');
  assert.equal(f.overlay(), 'r');
});

test('cancelled unknown-prefix text cannot acknowledge a later edit through an older empty echo', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.composer('a');
  await f.parsed();
  control(f, '\x17', 'w');
  f.key('b');
  f.key('\x7f', 'Backspace');
  // This is the earlier Ctrl+W echo; b and its deletion have not echoed yet.
  f.composer();
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), '');
  f.composer('b');
  await f.parsed();
  f.composer();
  await f.parsed();
  f.key('x');
  assert.equal(f.overlay(), '');
  f.composer('b');
  await f.parsed();
  f.composer('bx');
  await f.parsed();
  f.key('q');
  assert.equal(f.overlay(), 'q');
});

test('Enter after an unknown edit cannot acknowledge itself through an older empty echo', async () => {
  const f = fixture();
  f.composer('b');
  f.prediction.setEnabled(true);
  control(f, '\x15', 'u');
  f.key(' ');
  f.key('\r', 'Enter');
  f.composer();
  await f.parsed();
  f.key('x');
  assert.equal(f.overlay(), '');
  f.composer(' ');
  await f.parsed();
  f.composer();
  await f.parsed();
  f.key('y');
  assert.equal(f.overlay(), '');
  f.composer('x');
  await f.parsed();
  f.composer('xy');
  await f.parsed();
  f.key('z');
  assert.equal(f.overlay(), 'z');
});

for (const character of ['b', '中']) {
  test(`a recalled line ending in queued ${character} cannot acknowledge that input`, async () => {
    const f = fixture();
    f.prediction.setEnabled(true);
    f.key('\x1b[A', 'ArrowUp');
    f.key(character);
    f.composer('a' + character);
    await f.parsed();
    // Background redraws of the same line cannot disambiguate the two positions.
    await f.parsed();
    f.key('c');
    assert.equal(f.overlay(), '');
    f.composer('a' + character + character);
    await f.parsed();
    f.composer('a' + character + character + 'c');
    await f.parsed();
    f.key('d');
    assert.equal(f.overlay(), 'd');
  });
}

test('repeated characters keep ambiguous history echoes suspended until a distinct echo', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('\x1b[A', 'ArrowUp');
  f.key('b');
  f.composer('ab');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), '');
  f.composer('abb');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), '');
  f.composer('abbb');
  await f.parsed();
  f.composer('abbbc');
  await f.parsed();
  f.key('d');
  assert.equal(f.overlay(), 'd');
});

test('a queued IME group admits partial echoes without confirming the recalled prefix', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('\x1b[A', 'ArrowUp');
  f.event(f.textarea, 'compositionstart');
  f.event(f.textarea, 'compositionend', { data: '中文' });
  f.prediction.beforeInput('中文');
  f.composer('a中');
  await f.parsed();
  assert.equal(f.overlay(), '');
  f.composer('a中中');
  await f.parsed();
  f.composer('a中中文');
  await f.parsed();
  f.key('d');
  assert.equal(f.overlay(), 'd');
});

test('unsupported bulk commands cannot pretend to be one completed edit', async () => {
  const f = fixture();
  f.composer('old');
  f.prediction.setEnabled(true);
  // A clipboard paste without bracketed-paste mode can submit and then type again.
  f.prediction.paste('a\rc');
  f.key('c');
  f.composer();
  await f.parsed();
  f.composer('c');
  await f.parsed();
  f.key('z');
  assert.equal(f.overlay(), '');
  assert.deepEqual(f.pasted, ['a\rc']);
  assert.equal(f.screen.children.length, 1);
});

test('one complete CSI mouse report remains an unknown single edit rather than a bulk macro', async () => {
  const f = fixture();
  f.composer('old');
  f.prediction.setEnabled(true);
  f.prediction.beforeInput('\x1b[<0;5;22M');
  f.composer('changed');
  await f.parsed();
  f.key('a');
  assert.equal(f.overlay(), 'a');
});

test('repeated characters resume when the queued echoes fully catch up', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('\x1b[A', 'ArrowUp');
  f.key('b');
  f.composer('ab');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), '');
  f.composer('abb');
  await f.parsed();
  f.composer('abbb');
  await f.parsed();
  f.key('b');
  assert.equal(f.overlay(), 'b');
});

for (const enabled of [false, true]) {
  test(`empty bracketed clipboard paste is not an editor change with prediction ${enabled ? 'on' : 'off'}`, async () => {
    const f = fixture();
    f.prediction.setEnabled(enabled);
    f.event(f.textarea, 'paste');
    f.prediction.beforeInput('\x1b[200~\x1b[201~');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.prediction.setEnabled(true);
    f.key('a');
    assert.equal(f.overlay(), 'a');
  });
}

test('empty clipboard paste preserves a barrier for earlier unacknowledged input', async () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.key('a');
  f.event(f.textarea, 'paste');
  f.prediction.beforeInput('\x1b[200~\x1b[201~');
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.key('b');
  assert.equal(f.overlay(), '');
  f.composer('a');
  await f.parsed();
  f.key('c');
  assert.equal(f.overlay(), '');
  f.composer('abc');
  await f.parsed();
  f.key('d');
  assert.equal(f.overlay(), 'd');
});

test('empty framing without a paste source cannot bypass unsupported bulk suspension', () => {
  const f = fixture();
  f.prediction.setEnabled(true);
  f.prediction.beforeInput('\x1b[200~\x1b[201~');
  f.key('a');
  assert.equal(f.overlay(), '');
});
