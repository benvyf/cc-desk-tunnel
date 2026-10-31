import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { usePrefs } from './prefs.ts';
import { StopSequence } from './stopSequence.ts';

const owners =
  'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .quote-selection-toolbar';
export function useStopShortcut(
  root: RefObject<HTMLElement | null>,
  key: string,
  enabled: boolean,
  stop: () => void,
) {
  const shortcutsEnabled = usePrefs().shortcuts.enabled;
  const latest = useRef({ key, enabled: enabled && shortcutsEnabled, stop });
  latest.current = { key, enabled: enabled && shortcutsEnabled, stop };
  const composing = useRef(false);
  const resetActive = useRef<(() => void) | undefined>(undefined);
  // IME ownership outlives a run or a temporary loss of stop eligibility, including its end event.
  useEffect(() => {
    const doc = root.current?.ownerDocument ?? document,
      win = doc.defaultView!;
    const start = (event: CompositionEvent) => {
      composing.current = event.target instanceof Node && !!root.current?.contains(event.target);
      resetActive.current?.();
    };
    const end = () => {
      composing.current = false;
      resetActive.current?.();
    };
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target))
        composing.current = false;
      resetActive.current?.();
    };
    doc.addEventListener('compositionstart', start, true);
    doc.addEventListener('compositionend', end, true);
    doc.addEventListener('focusin', focus, true);
    doc.addEventListener('visibilitychange', end);
    win.addEventListener('blur', end);
    return () => {
      end();
      doc.removeEventListener('compositionstart', start, true);
      doc.removeEventListener('compositionend', end, true);
      doc.removeEventListener('focusin', focus, true);
      doc.removeEventListener('visibilitychange', end);
      win.removeEventListener('blur', end);
    };
  }, [root]);
  useEffect(() => {
    const element = root.current;
    if (!enabled || !shortcutsEnabled || !element) return;
    const doc = element.ownerDocument,
      win = doc.defaultView!;
    const sequence = new StopSequence();
    let pending: KeyboardEvent | null = null;
    const reset = () => {
      sequence.reset();
      pending = null;
    };
    resetActive.current = reset;
    const capture = (event: KeyboardEvent) => {
      // A key consumed with stopPropagation never reached accept. Do not combine it with a new key.
      if (pending) reset();
      const target = event.target instanceof Element ? event.target : null;
      if (
        latest.current.key !== key ||
        !latest.current.enabled ||
        event.key !== 'Escape' ||
        event.repeat ||
        event.isComposing ||
        composing.current ||
        event.keyCode === 229 ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey ||
        !target ||
        !element.contains(target) ||
        target.closest(
          '.native-terminal, .xterm, iframe, webview, [inert], .terminal-list, .approval-actions, .queued-editor, .conversation-find',
        ) ||
        [...doc.querySelectorAll(owners)].some((owner) => {
          const terminalOwner = owner.closest('.terminal-list');
          return (
            (!terminalOwner || terminalOwner.contains(target)) &&
            // Nonmodal menus only consume descendant keys, unlike modal/global popovers.
            (!owner.matches('.menu[role="menu"]') || owner.contains(target)) &&
            (!owner.matches('.slash-menu') ||
              !!target.closest('.composer-area')?.contains(owner)) &&
            !owner.closest('[inert], [hidden], [aria-hidden="true"]') &&
            owner.getClientRects().length > 0
          );
        })
      ) {
        reset();
        return;
      }
      // Remember ownership before local controls close a popup; honour local cancellation afterwards.
      pending = event;
    };
    const accept = (event: KeyboardEvent) => {
      if (pending !== event) return;
      pending = null;
      if (event.defaultPrevented || latest.current.key !== key || !latest.current.enabled) {
        reset();
        return;
      }
      event.preventDefault();
      if (sequence.press(key, win.performance.now())) latest.current.stop();
    };
    doc.addEventListener('keydown', capture, true);
    win.addEventListener('keydown', accept);
    doc.addEventListener('pointerdown', reset, true);
    return () => {
      reset();
      if (resetActive.current === reset) resetActive.current = undefined;
      doc.removeEventListener('keydown', capture, true);
      win.removeEventListener('keydown', accept);
      doc.removeEventListener('pointerdown', reset, true);
    };
  }, [root, key, enabled, shortcutsEnabled]);
}
