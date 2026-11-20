import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { gitError, gitFilePath } from './gitChanges.ts';
import type { GitChange, GitChangeList, GitFileDiff } from './gitChanges.ts';
import { pathKey } from './paths.ts';

// The base each project's changes are compared with, as chosen in the changes panel (GitChanges.tsx), which the
// preview's 改动 view of a file compares with as well. It lasts as long as the window does.
const bases = new Map<string, string>();
const baseListeners = new Set<() => void>();
export const gitBaseKey = (root: string, targetId?: string) => `${targetId ?? ''}|${root}`;
export function useGitBase(key: string) {
  const subscribe = useCallback((listener: () => void) => {
    baseListeners.add(listener);
    return () => {
      baseListeners.delete(listener);
    };
  }, []);
  const base = useSyncExternalStore(subscribe, () => bases.get(key) ?? '');
  const setBase = useCallback(
    (value: string) => {
      if (value === (bases.get(key) ?? '')) return;
      if (value) bases.set(key, value);
      else bases.delete(key);
      for (const listener of baseListeners) listener();
    },
    [key],
  );
  return [base, setBase] as const;
}

// Reading a project's changes runs git, so each project and base reads at most once at a time, with at most one
// read waiting after it, which every later ask joins. An ask wants an answer read since a time (`since`): the last
// answer, or the read under way, serves it if it started then or after. Reads for a change on disk (`throttle`)
// start at most once every 2.5 seconds, the last change being read after the wait.
type Waiting = {
  promise: Promise<GitChangeList>;
  resolve: (list: GitChangeList) => void;
  reject: (error: unknown) => void;
  notBefore: number;
  throttled: boolean;
};
type Slot = {
  input: { root: string; targetId?: string; base: string };
  running?: { started: number; promise: Promise<GitChangeList> };
  waiting?: Waiting;
  timer?: ReturnType<typeof setTimeout>;
  last?: { started: number; list: GitChangeList };
  // When the last read for a change on disk started.
  throttledAt: number;
  // When the folder was last found to be in no repository: not asked again for a minute.
  missing?: number;
};
const slots = new Map<string, Slot>();
const slotLimit = 32;
const diskInterval = 2500;
const notRepository = '项目不在 Git 仓库中。';
function start(slot: Slot) {
  clearTimeout(slot.timer);
  slot.timer = undefined;
  const waiting = slot.waiting;
  if (slot.running || !waiting) return;
  const wait = waiting.notBefore - Date.now();
  if (wait > 0) {
    slot.timer = setTimeout(() => start(slot), wait);
    return;
  }
  slot.waiting = undefined;
  const started = Date.now();
  if (waiting.throttled) slot.throttledAt = started;
  slot.running = { started, promise: waiting.promise };
  const { root, targetId, base } = slot.input;
  Promise.resolve()
    .then(() =>
      window.desktop!.git!.changes({
        root,
        ...(targetId ? { targetId } : {}),
        ...(base ? { base } : {}),
      }),
    )
    .then(
      (list) => {
        slot.last = { started, list };
        slot.missing = undefined;
        waiting.resolve(list);
      },
      (error: unknown) => {
        if (gitError(error, '') === notRepository) slot.missing = Date.now();
        waiting.reject(error);
      },
    )
    .finally(() => {
      slot.running = undefined;
      start(slot);
    });
}
export function requestChanges(
  input: { root: string; targetId?: string; base: string },
  since: number,
  options: { throttle?: boolean; knownMissing?: boolean } = {},
): Promise<GitChangeList> {
  const key = JSON.stringify([input.targetId ?? '', input.root, input.base]);
  let slot = slots.get(key);
  if (slot) slots.delete(key);
  slot ??= { input, throttledAt: 0 };
  slots.set(key, slot);
  // The least recently asked idle slots go past the limit.
  for (const [other, value] of slots) {
    if (slots.size <= slotLimit) break;
    if (value !== slot && !value.running && !value.waiting) slots.delete(other);
  }
  if (options.knownMissing && slot.missing && Date.now() - slot.missing < 60_000)
    return Promise.reject(new Error(notRepository));
  if (slot.last && slot.last.started >= since) return Promise.resolve(slot.last.list);
  if (slot.running && slot.running.started >= since) return slot.running.promise;
  const notBefore = options.throttle ? slot.throttledAt + diskInterval : 0;
  if (slot.waiting) {
    if (notBefore < slot.waiting.notBefore) {
      slot.waiting.notBefore = notBefore;
      slot.waiting.throttled ||= !!options.throttle;
      start(slot);
    }
    return slot.waiting.promise;
  }
  let resolve!: (list: GitChangeList) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<GitChangeList>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // Nobody may be waiting on a read that fails.
  promise.catch(() => {});
  slot.waiting = { promise, resolve, reject, notBefore, throttled: !!options.throttle };
  start(slot);
  return promise;
}

// The files the preview keeps to itself (electron/preview-files.cjs): in .git, .ssh, .claude or .codex, or named
// with a leading dot, below the folder they are shown from.
const privateDirectories = new Set(['.git', '.ssh', '.claude', '.codex']);
export function privateFile(root: string, path: string) {
  const parts = path
    .slice(root.replace(/[\\/]+$/, '').length)
    .split(/[\\/]/)
    .filter(Boolean);
  return (
    parts.some((part) => privateDirectories.has(part.toLowerCase())) ||
    !!parts.at(-1)?.startsWith('.')
  );
}

export type GitFileDiffState = GitFileDiff | { error: string };
export type GitFileState =
  // Not asked yet, or on its way.
  | { status: 'unknown' }
  // Nothing to show: no change to the file (`definite`), or its changes could not be read.
  | { status: 'none'; definite: boolean }
  | {
      status: 'changed';
      change: GitChange;
      list: GitChangeList;
      // The file's diff, once read; of an earlier list while the latest one's is read.
      diff?: GitFileDiffState;
      diffOf?: GitChangeList;
    };

// What was last known of each tab's file, so that a tab shown again starts from it rather than from nothing.
const known = new Map<string, GitFileState>();
const remember = (tab: string, state: GitFileState) => {
  known.delete(tab);
  known.set(tab, state);
  if (known.size > 64) known.delete(known.keys().next().value!);
};
const stale = '改动列表已过期，请刷新。';

// Whether a file of a project on this computer has changes against the base its project's changes panel uses,
// and, while its changes are shown (`wantDiff`, or a deleted file), what they are. Asked once as the tab is shown;
// after that a change on disk (`revision`) or a run's end is read at once only while the changes are shown and
// the window is; otherwise it waits for the window to come back or the changes to be shown.
export function useGitFile(
  tab: string,
  input: { root: string; path: string; base: string; busy?: boolean; revision: number } | null,
  wantDiff: boolean,
): [GitFileState, () => void] {
  const [state, setState] = useState<GitFileState>(
    () => (input && known.get(tab)) || { status: 'unknown' },
  );
  const update = useCallback(
    (next: (state: GitFileState) => GitFileState) =>
      setState((previous) => {
        const value = next(previous);
        if (value !== previous) remember(tab, value);
        return value;
      }),
    [tab],
  );
  const root = input?.root;
  const path = input?.path;
  const base = input?.base ?? '';
  const revision = input?.revision ?? 0;
  const busy = !!input?.busy;
  const turn = useRef(0);
  const readAt = useRef(0);
  // The time of the latest change not read yet.
  const dirty = useRef<number | null>(null);
  const change = state.status === 'changed' ? state.change : undefined;
  const wanted = wantDiff || change?.status === 'D';
  const shown = useRef(wanted);
  shown.current = wanted;
  const read = useCallback(
    (since: number, throttle = false) => {
      if (!root || !path || !window.desktop?.git) return;
      const mine = ++turn.current;
      dirty.current = null;
      readAt.current = Date.now();
      requestChanges({ root, base }, since, { throttle, knownMissing: true }).then(
        (list) => {
          if (mine !== turn.current) return;
          const key = pathKey(path);
          const found = list.files.find(
            (file) => !file.path.endsWith('/') && pathKey(gitFilePath(list.top, file.path)) === key,
          );
          update((previous) =>
            found
              ? {
                  status: 'changed',
                  change: found,
                  list,
                  ...(previous.status === 'changed' && previous.diff
                    ? { diff: previous.diff, diffOf: previous.diffOf }
                    : {}),
                }
              : previous.status === 'none' && previous.definite
                ? previous
                : { status: 'none', definite: true },
          );
        },
        (error: unknown) => {
          if (mine !== turn.current) return;
          const definite = gitError(error, '') === notRepository;
          update((previous) =>
            previous.status === 'none' && previous.definite === definite
              ? previous
              : { status: 'none', definite },
          );
        },
      );
    },
    [root, path, base, update],
  );
  // Asked as the tab is shown, so that it offers its changes; an answer of the last three seconds serves.
  useEffect(() => {
    read(Date.now() - 3000);
  }, [read]);
  const readNow = (since: number, throttle = false) => {
    dirty.current = Math.max(dirty.current ?? 0, since);
    if (shown.current && !document.hidden) read(dirty.current, throttle);
  };
  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    readNow(Date.now(), true);
  }, [revision]);
  const wasBusy = useRef(busy);
  useEffect(() => {
    // A little before now, so that every tab and the changes panel, told in the same moment, share one read.
    if (wasBusy.current && !busy) readNow(Date.now() - 250);
    wasBusy.current = busy;
  }, [busy]);
  // Back in the window: what changed meanwhile, or, while the changes are shown, anything after a few seconds.
  useEffect(() => {
    if (!root) return;
    const again = () => {
      if (document.hidden) return;
      if (dirty.current !== null) read(dirty.current);
      else if (shown.current && Date.now() - readAt.current > 3000) read(Date.now() - 250);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [root, read]);
  // The changes shown: what changed while they were not is read now.
  useEffect(() => {
    if (wanted && dirty.current !== null) read(dirty.current);
  }, [wanted, read]);
  // The diff, read for the latest list: of the tree as it is. A list made stale by another read of the project
  // (the changes panel's, with another HEAD) is read again, once, before saying so.
  const list = state.status === 'changed' ? state.list : undefined;
  const current = state.status === 'changed' && state.diffOf === state.list;
  const healed = useRef(false);
  useEffect(() => {
    if (!wanted || !root || !list || !change || current) return;
    let gone = false;
    const keep = (diff: GitFileDiffState) => {
      if (!gone)
        update((previous) =>
          previous.status === 'changed' && previous.list === list
            ? { ...previous, diff, diffOf: list }
            : previous,
        );
    };
    window.desktop!.git!.fileDiff({ root, against: list.against, path: change.path }).then(
      (diff) => {
        healed.current = false;
        keep(diff);
      },
      (error: unknown) => {
        const message = gitError(error, '读取差异失败。');
        if (!gone && message === stale && !healed.current) {
          healed.current = true;
          read(Date.now());
        } else keep({ error: message });
      },
    );
    return () => {
      gone = true;
    };
  }, [wanted, root, list, change, current, update, read]);
  const refresh = useCallback(() => {
    healed.current = false;
    read(Date.now());
  }, [read]);
  return [input ? state : { status: 'none', definite: false }, refresh];
}
