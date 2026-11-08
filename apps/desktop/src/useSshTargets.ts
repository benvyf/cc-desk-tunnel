import { useEffect, useState } from 'react';
import type { SshTarget } from './desktop.d.ts';

// The first disk snapshot must not replace a newer connection event.
export function useSshTargets(): SshTarget[] {
  const api = window.desktop?.ssh;
  const [targets, setTargets] = useState<SshTarget[]>([]);
  useEffect(() => {
    if (!api) return;
    let current = true;
    let changed = false;
    const off = api.onChanged((entries) => {
      changed = true;
      if (current) setTargets(entries);
    });
    void api.list().then(
      (entries) => {
        if (current && !changed) setTargets(entries);
      },
      () => {},
    );
    return () => {
      current = false;
      off();
    };
  }, [api]);
  return targets;
}
