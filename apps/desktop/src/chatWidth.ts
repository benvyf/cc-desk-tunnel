export const chatWidthKey = 'cc-chat-content-width';
export const chatWidthMin = 640;
// Leave room for the hit strips, scrollbar and existing turn navigator.
export const chatWidthEdges = 120;
export const resolveChatWidth = (column: number, preference: number | null) =>
  Math.min(
    Math.max(chatWidthMin, preference ?? 820),
    Math.max(chatWidthMin, column - chatWidthEdges),
  );

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem' | 'removeItem'>;
// Survives a main-session/terminal remount even when this profile cannot write storage.
let windowPreference: { width: number | null } | undefined;
// Keep this one window-lifetime invalidation listener while Settings/Terminal hides the controls.
// It retains no DOM nodes; HMR removes the old listener before replacing this module.
if (typeof window !== 'undefined') {
  const invalidate = (event: StorageEvent) => {
    if (event.key === chatWidthKey || event.key === null) windowPreference = undefined;
  };
  window.addEventListener('storage', invalidate);
  import.meta.hot?.dispose(() => window.removeEventListener('storage', invalidate));
}

export function readChatWidth(storage?: Reader): number | null {
  if (!storage && windowPreference) return windowPreference.width;
  try {
    const raw = (storage ?? localStorage).getItem(chatWidthKey);
    if (raw === null || !raw.trim()) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.max(chatWidthMin, Math.round(value)) : null;
  } catch {
    return null;
  }
}

export function saveChatWidth(width: number | null, storage?: Writer): boolean {
  if (!storage) windowPreference = { width };
  try {
    const target = storage ?? localStorage;
    if (width === null) target.removeItem(chatWidthKey);
    else target.setItem(chatWidthKey, String(Math.round(width)));
    return true;
  } catch {
    // The current window still keeps its in-memory preference.
    return false;
  }
}

// A genuine storage event from another same-origin window supersedes our local fallback.
export function reloadChatWidth(): number | null {
  windowPreference = undefined;
  return readChatWidth();
}
