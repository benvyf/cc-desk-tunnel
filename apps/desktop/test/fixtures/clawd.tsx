import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Clawd from '../../src/Clawd.tsx';
import type { ClawdPose, ClawdState } from '../../src/Clawd.tsx';
import '../../src/style.css';

// Each Clawd stands on a zero-height line at the bottom of its tile, as on the message box's top edge.
const ground = document.createElement('style');
ground.textContent =
  '.clawd-ground { position: absolute; left: 0; right: 0; bottom: 0; height: 0; }';
document.head.append(ground);

// Every pose held still (the gallery), and one live Clawd whose state the buttons change.
const poses: ClawdPose[] = [
  'stand',
  'blink',
  'wink',
  'wave',
  'lift',
  'put',
  'type',
  'tap',
  'typeBlink',
];
function Fixture() {
  const [state, setState] = useState<ClawdState>('idle');
  return (
    <main style={{ padding: 24, display: 'grid', gap: 24 }}>
      <div className="clawd-gallery" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {poses.map((pose) => (
          <figure key={pose} data-gallery={pose} style={{ margin: 0, position: 'relative' }}>
            <div
              style={{
                position: 'relative',
                width: 120,
                height: 66,
                borderBottom: '1px solid #ddd',
              }}
            >
              <div className="clawd-ground">
                <Clawd state="idle" pose={pose} />
              </div>
            </div>
            <figcaption style={{ font: '12px sans-serif' }}>{pose}</figcaption>
          </figure>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['idle', 'working', 'waiting'] as const).map((value) => (
          <button key={value} type="button" onClick={() => setState(value)}>
            {value}
          </button>
        ))}
      </div>
      <div
        className="clawd-live"
        style={{ position: 'relative', width: 300, height: 80, borderBottom: '1px solid #ddd' }}
      >
        <div className="clawd-ground">
          <Clawd state={state} />
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
