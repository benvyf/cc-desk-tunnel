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
  release?: {
    build: number;
    appVersion: string;
    protocol: number;
    notes: string;
    size: number;
  } | null;
  received?: number;
  message?: string;
  pending?: { targetBuild: number; status: string } | null;
};

export function managedUpdateNotice(state: ManagedUpdateState): string | null {
  if (state.phase === 'disabled') return null;
  if (state.phase === 'error') return '更新检查或安装失败，点击重试';
  const { identity, release } = state;
  if (!identity || !release || release.build <= identity.build) return null;
  if (release.protocol !== identity.protocol) return '新版客户端需要配套升级服务端';
  if (state.phase === 'downloading') return '正在下载客户端更新';
  if (state.phase === 'ready') return '客户端更新已下载，可以安装';
  return `客户端可更新到 ${release.appVersion} · Build ${release.build}`;
}

export function useManagedUpdate() {
  const [state, setState] = useState<ManagedUpdateState>({ phase: 'disabled' });
  useEffect(() => {
    const api = window.desktop?.managedUpdate;
    if (!api) return;
    let mounted = true;
    let notified = false;
    const take = (value: ManagedUpdateState) => {
      if (mounted) setState(value);
    };
    const unsubscribe = api.subscribe((value) => {
      notified = true;
      take(value);
    });
    void api
      .state()
      .then((value) => {
        if (!notified) take(value);
      })
      .catch((error: unknown) => {
        if (!notified)
          take({
            phase: 'error',
            message: `无法读取更新状态：${error instanceof Error ? error.message : '请重试。'}`,
          });
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  return state;
}
