import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import ComposerControls from '../../src/ComposerControls.tsx';
import type { Effort } from '@cc-desk-tunnel/protocol';

let replaceLevels: (levels: Effort[]) => void;
export function changeLevels(levels: Effort[]) {
  replaceLevels(levels);
}

export function mount() {
  document.body.innerHTML = '<main style="position:fixed;bottom:32px;right:32px"></main>';
  function Demo() {
    const [effort, setEffort] = useState<Effort | null>('high');
    const [calls, setCalls] = useState<(Effort | null)[]>([]);
    const [disabled, setDisabled] = useState(false);
    const [fail, setFail] = useState(false);
    const [levels, setLevels] = useState<Effort[]>(['low', 'medium', 'high', 'xhigh', 'max']);
    replaceLevels = setLevels;
    return (
      <>
        <ComposerControls
          model="opus"
          effort={effort}
          capabilities={{
            type: 'native.capabilities',
            account: {},
            commands: [],
            models: [
              {
                value: 'opus',
                displayName: 'Opus',
                resolvedModel: 'claude-opus-5-5',
                description: '',
                source: 'native',
                supportedEffortLevels: levels,
              },
            ],
          }}
          nativeSession={null}
          metrics={null}
          openAccount={() => {}}
          disabled={disabled}
          refreshing={false}
          canRefreshModels
          refresh={() => {}}
          configure={async (values) => {
            if (values.effort === undefined) return;
            const next = values.effort;
            setCalls((previous) => [...previous, next]);
            setDisabled(true);
            await new Promise((resolve) => setTimeout(resolve, 400));
            if (!fail) setEffort(next);
            setDisabled(false);
          }}
        />
        <output aria-label="已提交">{JSON.stringify(calls)}</output>
        <button onClick={() => setFail(!fail)}>切换失败</button>
      </>
    );
  }
  createRoot(document.querySelector('main')!).render(<Demo />);
}
