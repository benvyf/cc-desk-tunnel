import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { charCellWidth, PredictiveEchoAddon, type XtermTerminal } from 'xterm-zerolag-input';

export type InputOrigin = 'key' | 'ime' | 'paste' | 'unknown';
export type PredictionInput =
  { kind: 'text'; text: string } | { kind: 'backspace' } | { kind: 'clear' };
export type PredictionContext = {
  running: boolean;
  visible: boolean;
  connected: boolean;
  closing: boolean;
};
export type TerminalPrediction = {
  beforeInput(data: string): void;
  paste(text: string): void;
  clear(): void;
  refresh(): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
};

const ordinaryText = /^[\x20-\x7e\u4e00-\u9fff，。！？：；（）【】《》、]*$/u;
const footerText = new Set([
  '  ⏸ manual mode on',
  '  ⏸ manual mode on · ? for shortcuts · ← for agents',
]);

export function classifyTerminalInput(data: string, origin: InputOrigin): PredictionInput {
  if (origin === 'paste' || origin === 'unknown') return { kind: 'clear' };
  if (origin === 'key' && data === '\x7f') return { kind: 'backspace' };
  const chars = Array.from(data);
  if (!chars.length || chars.length > 32 || (origin === 'key' && chars.length !== 1)) {
    return { kind: 'clear' };
  }
  if (!ordinaryText.test(data) || /[/@]/u.test(data)) return { kind: 'clear' };
  return { kind: 'text', text: data };
}

// Only the sampled Linux composer is recognized. History/model/project text is irrelevant.
function inspectComposer(terminal: Terminal) {
  const { cols, rows } = terminal;
  const buffer = terminal.buffer.active;
  const { cursorX: col, cursorY: row } = buffer;
  if (
    cols > 400 ||
    cols < 8 ||
    rows < 4 ||
    buffer.type !== 'alternate' ||
    buffer.baseY !== buffer.viewportY
  )
    return null;
  if (row !== rows - 3 || col < 2 || col > cols - 4) return null;
  const line = buffer.getLine(buffer.baseY + row);
  if (!line || line.getCell(0)?.getChars() !== '❯' || line.getCell(1)?.getChars() !== '\u00a0')
    return null;
  const border = '─'.repeat(cols);
  if (
    buffer.getLine(buffer.baseY + row - 1)?.translateToString(true) !== border ||
    buffer.getLine(buffer.baseY + row + 1)?.translateToString(true) !== border
  )
    return null;
  if (!footerText.has(buffer.getLine(buffer.baseY + row + 2)?.translateToString(true) ?? ''))
    return null;
  const cursor = line.getCell(col);
  if (cursor?.getChars() !== ' ' || !cursor.isInverse()) return null;
  for (let x = col + 1; x < cols; x++) {
    if (line.getCell(x)?.getChars().trim()) return null;
  }
  const input = line.translateToString(false, 2, col);
  if (!ordinaryText.test(input) || /[/@]/u.test(input)) return null;
  return { row, col, input, signature: `${row}:${col}:${input}` };
}

export function createTerminalPrediction(
  terminal: Terminal,
  host: HTMLElement,
  context: () => PredictionContext,
): TerminalPrediction {
  const document = host.ownerDocument;
  const window = document.defaultView;
  const textarea = terminal.textarea;
  const disposables: { dispose(): void }[] = [];
  const ownedOverlays = new Set<Element>();
  const addonTerminal = terminal as unknown as XtermTerminal;
  let addon: PredictiveEchoAddon | null = null;
  let disposed = false;
  let failed = false;
  let enabled = false;
  let previousProposedApi: boolean | undefined;
  let changedProposedApi = false;
  let composing = false;
  let keyTicket: { text: string } | null = null;
  let imeTicket: object | null = null;
  let pasteDepth = 0;
  let pasteTicket: object | null = null;
  let imeTimer: ReturnType<typeof setTimeout> | undefined;
  let pasteTimer: ReturnType<typeof setTimeout> | undefined;
  let modalOpen = false;
  let painting = false;
  let pending: { char: string; width: number }[] = [];
  const lateEchoSignatures = new Set<string>();
  let deletedPending = false;
  let confirmedTotal = 0;
  let heldSignatures: Set<string> | null = null;
  let heldExpected: ReturnType<typeof inspectComposer> = null;
  let lastSignature: string | null = null;

  const restoreOption = () => {
    if (!changedProposedApi) return;
    changedProposedApi = false;
    terminal.options.allowProposedApi = previousProposedApi;
  };
  const unload = () => {
    const current = addon;
    addon = null;
    pending = [];
    lateEchoSignatures.clear();
    deletedPending = false;
    try {
      current?.dispose();
    } catch {
      /* The owned DOM is also removed below. */
    }
    for (const overlay of ownedOverlays) {
      try {
        overlay.remove();
      } catch {
        /* A broken renderer must not block input. */
      }
    }
    ownedOverlays.clear();
    try {
      restoreOption();
    } catch {
      /* The terminal might already be disposed. */
    }
  };
  const fail = () => {
    failed = true;
    enabled = false;
    painting = false;
    unload();
  };
  const safely = (action: () => void) => {
    if (disposed || failed) return;
    try {
      action();
    } catch {
      fail();
    }
  };
  const active = () => {
    const state = context();
    return (
      enabled &&
      state.running &&
      state.visible &&
      state.connected &&
      !state.closing &&
      !modalOpen &&
      document.visibilityState !== 'hidden' &&
      document.hasFocus() &&
      host.contains(document.activeElement)
    );
  };
  const holdEditor = () => {
    if (heldSignatures === null) {
      const snapshot = inspectComposer(terminal);
      const buffer = terminal.buffer.active;
      heldSignatures = new Set([
        snapshot?.signature ??
          lastSignature ??
          `${buffer.cursorY}:${buffer.cursorX}:${buffer.getLine(buffer.baseY + terminal.rows - 3)?.translateToString(true, 0, Math.min(terminal.cols, 400)) ?? ''}`,
      ]);
      // Keep states removed by local backspace: their earlier wire echoes can still arrive.
      for (const signature of lateEchoSignatures) heldSignatures.add(signature);
      heldExpected = snapshot
        ? {
            ...snapshot,
            input: snapshot.input + pending.map(({ char }) => char).join(''),
            col: snapshot.col + pending.reduce((sum, { width }) => sum + width, 0),
          }
        : null;
    }
  };
  const advanceHeldEdit = (data: string) => {
    if (!heldSignatures) return;
    if (heldExpected)
      heldSignatures.add(`${heldExpected.row}:${heldExpected.col}:${heldExpected.input}`);
    if (data === '\r') {
      heldExpected = { row: terminal.rows - 3, col: 2, input: '', signature: '' };
    } else if (heldExpected && data === '\x7f') {
      const chars = Array.from(heldExpected.input);
      chars.pop();
      heldExpected.input = chars.join('');
    } else if (heldExpected && classifyTerminalInput(data, 'ime').kind === 'text') {
      heldExpected.input += data;
    } else if (data.length > 1 && !/^\x1b\[[A-Za-z0-9;]*[A-Za-z~]$/u.test(data)) {
      heldExpected = null;
    }
    if (heldExpected) {
      // Every supported BMP glyph has the verified width used by the prediction gate.
      heldExpected.col =
        2 + Array.from(heldExpected.input).reduce((sum, char) => sum + (char > '~' ? 2 : 1), 0);
      heldExpected.signature = `${heldExpected.row}:${heldExpected.col}:${heldExpected.input}`;
    }
    // Preserve at most 32 prior predictions plus 32 suppressed edits and the baseline.
    if (heldSignatures.size > 65 || (heldExpected?.col ?? 0) > 400) fail();
  };
  const clearPredictions = (
    hold = pending.length > 0 || lateEchoSignatures.size > 0 || heldSignatures !== null,
  ) => {
    if (!addon) return;
    if (hold) holdEditor();
    addon.clearPredictions();
    for (const overlay of ownedOverlays) overlay.replaceChildren();
    pending = [];
    confirmedTotal = addon.state.confirmedTotal;
  };
  const clear = () => safely(() => clearPredictions());
  const reconcile = () => {
    if (!addon) return;
    addon.reconcile();
    const state = addon.state;
    const confirmed = state.confirmedTotal - confirmedTotal;
    pending.splice(0, confirmed);
    confirmedTotal = state.confirmedTotal;
    // Expiry/mismatch is not an acknowledgement. Do not re-anchor on a stale display.
    if (state.outstanding !== pending.length) clearPredictions();
    else if (confirmed > 0 && !pending.length && !deletedPending && heldSignatures === null) {
      lateEchoSignatures.clear();
    }
  };
  const parsed = () =>
    safely(() => {
      const snapshot = inspectComposer(terminal);
      if (
        snapshot &&
        heldSignatures !== null &&
        heldExpected?.signature === snapshot.signature &&
        !heldSignatures.has(snapshot.signature)
      ) {
        heldSignatures = null;
        heldExpected = null;
        lateEchoSignatures.clear();
        deletedPending = false;
      }
      if (!addon) return;
      if (!active() || composing || !snapshot) {
        clearPredictions();
        return;
      }
      lastSignature = snapshot.signature;
      reconcile();
    });
  const listen = (
    target: EventTarget | null | undefined,
    name: string,
    callback: (event: Event) => void,
    capture = true,
  ) => {
    if (!target) return;
    const listener = (event: Event) => safely(() => callback(event));
    target.addEventListener(name, listener, capture);
    disposables.push({ dispose: () => target.removeEventListener(name, listener, capture) });
  };

  // xterm fires onKey immediately before onData in one JS call stack. A DOM listener's
  // microtask may run before the next native listener, so DOM keydown is not a source ticket.
  disposables.push(
    terminal.onKey(({ key, domEvent }) =>
      safely(() => {
        keyTicket = null;
        imeTicket = null;
        if (composing || domEvent.isComposing) return;
        if (domEvent.ctrlKey || domEvent.altKey || domEvent.metaKey) {
          clearPredictions();
          return;
        }
        if (Array.from(key).length === 1) {
          const ticket = { text: key };
          keyTicket = ticket;
          queueMicrotask(() => {
            if (keyTicket === ticket) keyTicket = null;
          });
        } else {
          clearPredictions();
        }
      }),
    ),
  );
  listen(textarea, 'compositionstart', () => {
    composing = true;
    keyTicket = null;
    imeTicket = null;
    // Starting a composition sends nothing. With no outstanding run, its commit can predict.
    clearPredictions(pending.length > 0);
  });
  listen(
    textarea,
    'compositionend',
    () => {
      if (!composing) return;
      composing = false;
      keyTicket = null;
      const ticket = {};
      imeTicket = ticket;
      // xterm's earlier bubble listener has already queued its final onData timer.
      if (imeTimer !== undefined) clearTimeout(imeTimer);
      imeTimer = setTimeout(() => {
        imeTimer = undefined;
        if (imeTicket === ticket) imeTicket = null;
      }, 0);
    },
    false,
  );
  listen(textarea, 'paste', () => {
    const ticket = {};
    pasteTicket = ticket;
    keyTicket = null;
    imeTicket = null;
    clearPredictions();
    if (pasteTimer !== undefined) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
      pasteTimer = undefined;
      if (pasteTicket === ticket) pasteTicket = null;
    }, 0);
  });
  listen(textarea, 'blur', clear);
  listen(window, 'blur', clear);
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') clearPredictions();
  });
  listen(document, 'focusin', () => {
    if (!host.contains(document.activeElement)) clearPredictions();
  });
  disposables.push(terminal.onWriteParsed(parsed));
  disposables.push(terminal.onScroll(clear));
  disposables.push(terminal.onResize(clear));

  const modalSelector = 'dialog[open], [role="dialog"][aria-modal="true"]';
  const updateModal = () => {
    modalOpen = !!document.querySelector(modalSelector);
    if (modalOpen) clearPredictions();
  };
  // Observe mode changes, never scan the document on each keystroke.
  const Observer = window?.MutationObserver;
  if (Observer && document.body) {
    const containsModal = (node: Node) =>
      node.nodeType === 1 &&
      ((node as Element).matches(modalSelector) ||
        !!(node as Element).querySelector(modalSelector));
    const observer = new Observer((records) =>
      safely(() => {
        if (
          records.some((record) =>
            record.type === 'attributes'
              ? record.target.nodeType === 1 &&
                ((record.target as Element).matches('dialog, [role="dialog"]') ||
                  record.oldValue === 'dialog')
              : [...record.addedNodes, ...record.removedNodes].some(containsModal),
          )
        )
          updateModal();
      }),
    );
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['open', 'aria-modal', 'role'],
    });
    disposables.push({ dispose: () => observer.disconnect() });
  }

  return {
    beforeInput(data) {
      // An empty callback edits nothing and must not establish an editing barrier.
      if (!data) return;
      safely(() => {
        let origin: InputOrigin = 'unknown';
        if (pasteDepth || pasteTicket) origin = 'paste';
        else if (imeTicket && !composing) origin = 'ime';
        else if (keyTicket?.text === data) origin = 'key';
        keyTicket = null;
        imeTicket = null;
        // xterm's own focus/device replies share onData but do not edit the remote composer.
        if (origin === 'unknown' && /^\x1b\[(?:[IO]|\?[0-9;]*c)$/u.test(data)) return;
        if (!addon) {
          if (inspectComposer(terminal) || heldSignatures !== null) {
            holdEditor();
            advanceHeldEdit(data);
          }
          return;
        }
        const input = classifyTerminalInput(data, origin);
        const snapshot = inspectComposer(terminal);
        if (!active() || composing || !snapshot || input.kind === 'clear') {
          clearPredictions(!!snapshot || pending.length > 0 || heldSignatures !== null);
          advanceHeldEdit(data);
          return;
        }
        lastSignature = snapshot.signature;
        reconcile();
        if (heldSignatures !== null) {
          clearPredictions();
          advanceHeldEdit(data);
          return;
        }
        if (input.kind === 'backspace') {
          if (!pending.length || !addon.predictBackspace()) {
            clearPredictions(true);
            advanceHeldEdit(data);
          } else {
            pending.pop();
            deletedPending = true;
            holdEditor();
          }
          return;
        }
        const entries = Array.from(input.text, (char) => ({
          char,
          width: charCellWidth(addonTerminal, char),
        }));
        if (
          entries.some(({ width }) => width !== 1 && width !== 2) ||
          pending.length + entries.length > 32 ||
          snapshot.col +
            pending.reduce((sum, { width }) => sum + width, 0) +
            entries.reduce((sum, { width }) => sum + width, 0) >
            terminal.cols - 4
        ) {
          clearPredictions(true);
          advanceHeldEdit(data);
          return;
        }
        let candidateInput = snapshot.input + pending.map(({ char }) => char).join('');
        let candidateCol = snapshot.col + pending.reduce((sum, { width }) => sum + width, 0);
        const candidates = new Set(lateEchoSignatures);
        for (const entry of entries) {
          candidateInput += entry.char;
          candidateCol += entry.width;
          candidates.add(`${snapshot.row}:${candidateCol}:${candidateInput}`);
        }
        // Repeated typing/deleting without acknowledgement cannot create unbounded history.
        if (candidates.size > 32) {
          clearPredictions(true);
          advanceHeldEdit(data);
          return;
        }
        painting = true;
        try {
          for (const char of input.text) {
            if (!addon.predictChar(char)) {
              fail();
              return;
            }
          }
          pending.push(...entries);
          for (const signature of candidates) lateEchoSignatures.add(signature);
        } finally {
          painting = false;
        }
      });
    },
    paste(text) {
      // The exact original text still goes through xterm's existing paste path once.
      clear();
      keyTicket = null;
      imeTicket = null;
      pasteDepth++;
      try {
        terminal.paste(text);
      } finally {
        pasteDepth--;
      }
    },
    clear,
    refresh() {
      safely(() => {
        clearPredictions();
        addon?.refreshFont();
      });
    },
    setEnabled(value) {
      safely(() => {
        if (enabled === value) return;
        enabled = value;
        keyTicket = null;
        imeTicket = null;
        if (!value) {
          if (pending.length || lateEchoSignatures.size) holdEditor();
          unload();
          return;
        }
        updateModal();
        previousProposedApi = terminal.options.allowProposedApi;
        changedProposedApi = true;
        terminal.options.allowProposedApi = true;
        addon = new PredictiveEchoAddon({
          ttlMs: 800,
          maxPending: 32,
          edgeMarginCells: 4,
          predictWhen: () => painting && heldSignatures === null && enabled,
        });
        const screen = terminal.element?.querySelector('.xterm-screen');
        const existing = new Set(screen?.querySelectorAll('[data-predictive-echo]'));
        try {
          terminal.loadAddon(addon as unknown as ITerminalAddon);
        } finally {
          for (const overlay of screen?.querySelectorAll('[data-predictive-echo]') ?? []) {
            if (!existing.has(overlay)) ownedOverlays.add(overlay);
          }
        }
        confirmedTotal = addon.state.confirmedTotal;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      keyTicket = null;
      imeTicket = null;
      pasteTicket = null;
      if (imeTimer !== undefined) clearTimeout(imeTimer);
      if (pasteTimer !== undefined) clearTimeout(pasteTimer);
      unload();
      for (const disposable of disposables) {
        try {
          disposable.dispose();
        } catch {
          /* Release the remaining listeners too. */
        }
      }
    },
  };
}
