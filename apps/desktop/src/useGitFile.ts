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

// The changes of a project on this computer, read once for the tabs that ask together (one window focus, one run
// ending, tabs gone between): an answer under three seconds old, or one on its way, serves them all. A change on
// disk, or a run's end, asks afresh, since what was on its way was read before it.
const lists = new Map<string, { at: number; promise: Promise<GitChangeList> }>();
function listChanges(root: string, base: string, fresh: boolean) {
  const key = `${root}\0${base}`;
  const cached = lists.get(key);
  if (!fresh && cached && (!cached.at || Date.now() - cached.at < 3000)) return cached.promise;
  const entry = {
    at: 0,
    promise: window.desktop!.git!.changes({ root, ...(base ? { base } : {}) }),
  };
  lists.set(key, entry);
  entry.promise.then(
    () => {
      entry.at = Date.now();
    },
    () => {
      if (lists.get(key) === entry) lists.delete(key);
    },
  );
  return entry.promise;
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

// Whether a file of a project on this computer has changes against the base its project's changes panel uses,
// and, while `wantDiff`, what they are. Read again where the changes panel reads them again: back in the window,
// a run over, and the file changed on disk (`revision`).
export function useGitFile(
  tab: string,
  input: { root: string; path: string; base: string; busy?: boolean; revision: number } | null,
  wantDiff: boolean,
): GitFileState {
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
  const [asked, setAsked] = useState(0);
  const turn = useRef(0);
  const loadedAt = useRef(0);
  const inFlight = useRef(false);
  const root = input?.root;
  const path = input?.path;
  const base = input?.base ?? '';
  const revision = input?.revision ?? 0;
  // The revision last read for: one past it is a change on disk.
  const readFor = useRef(revision);
  // A run has ended since the last read.
  const runEnded = useRef(false);
  useEffect(() => {
    if (!root || !path || !window.desktop?.git) {
      update((previous) =>
        previous.status === 'none' ? previous : { status: 'none', definite: false },
      );
      return;
    }
    const mine = ++turn.current;
    inFlight.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = revision !== readFor.current;
    readFor.current = revision;
    const fresh = changed || runEnded.current;
    runEnded.current = false;
    const read = () =>
      listChanges(root, base, fresh).then(
        (list) => {
          if (mine !== turn.current) return;
          const key = pathKey(path);
          const change = list.files.find(
            (file) => !file.path.endsWith('/') && pathKey(gitFilePath(list.top, file.path)) === key,
          );
          update((previous) =>
            change
              ? {
                  status: 'changed',
                  change,
                  list,
                  ...(previous.status === 'changed' && previous.diff
                    ? { diff: previous.diff, diffOf: previous.diffOf }
                    : {}),
                }
              : { status: 'none', definite: true },
          );
        },
        () => {
          if (mine !== turn.current) return;
          update(() => ({ status: 'none', definite: false }));
        },
      );
    // A file saved again and again is read once it rests a moment.
    if (changed) timer = setTimeout(() => void read().finally(done), 250);
    else void read().finally(done);
    function done() {
      if (mine !== turn.current) return;
      inFlight.current = false;
      loadedAt.current = Date.now();
    }
    return () => clearTimeout(timer);
  }, [root, path, base, revision, asked, update]);
  // Back in the window, or a run over: the tree may have changed.
  useEffect(() => {
    if (!root) return;
    const again = () => {
      if (!inFlight.current && Date.now() - loadedAt.current > 3000) setAsked((value) => value + 1);
    };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [root]);
  const busy = !!input?.busy;
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      runEnded.current = true;
      setAsked((value) => value + 1);
    }
    wasBusy.current = busy;
  }, [busy]);
  // The diff, read for the latest list: of the tree as it is.
  const list = state.status === 'changed' ? state.list : undefined;
  const change = state.status === 'changed' ? state.change : undefined;
  const current = state.status === 'changed' && state.diffOf === state.list;
  // A deleted file has nothing else to show.
  const wanted = wantDiff || change?.status === 'D';
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
    window
      .desktop!.git!.fileDiff({ root, against: list.against, path: change.path })
      .then(keep, (error: unknown) => keep({ error: gitError(error, '读取差异失败。') }));
    return () => {
      gone = true;
    };
  }, [wanted, root, list, change, current, update]);
  return input ? state : { status: 'none', definite: false };
}
