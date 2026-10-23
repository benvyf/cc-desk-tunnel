import { useEffect, useState } from 'react';

export type ManagedUpdateState = {
  phase:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'preparing'
    | 'installing'
    | 'error';
  identity?: { build: number; channel: string; appVersion: string; protocol: number };
  release?: { build: number; appVersion: string; notes: string; size: number } | null;
  received?: number;
  message?: string;
  pending?: { targetBuild: number; status: string } | null;
};
export function useManagedUpdate() {
  const [state, setState] = useState<ManagedUpdateState>({ phase: 'disabled' });
  useEffect(() => {
    const api = window.desktop?.managedUpdate;
    if (!api) return;
    let mounted = true;
    const take = (value: ManagedUpdateState) => {
      if (mounted) setState(value);
    };
    const unsubscribe = api.subscribe(take);
    void api
      .state()
      .then(take)
      .catch(() => {});
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  return state;
}
