import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStopShortcut } from '../../src/useStopShortcut.ts';
import { Button } from '../../src/ui.tsx';
import '../../src/style.css';

function Fixture() {
  const root = useRef<HTMLElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    initial = useRef(true);
  const [run, setRun] = useState('A'),
    [enabled, setEnabled] = useState(true),
    [stopped, setStopped] = useState<string[]>([]);
  useStopShortcut(root, run, enabled, () => setStopped((values) => [...values, run]));
  useLayoutEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    // Remote run/status changes can commit between rendering and passive listener cleanup.
    input.current?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  }, [run, enabled]);
  return (
    <>
      <main ref={root}>
        <textarea ref={input} aria-label="消息" />
        <Button onClick={() => setRun('B')}>替换运行</Button>
        <Button onClick={() => setEnabled(false)}>禁用停止</Button>
        <Button onClick={() => setEnabled(true)}>启用停止</Button>
        <output aria-label="停止记录">{stopped.join(',')}</output>
      </main>
      {new URLSearchParams(location.search).has('terminal-list') && (
        <aside className="terminal-list">
          <input aria-label="筛选终端" />
          <div role="listbox" aria-label="终端结果">
            <button role="option">终端</button>
          </div>
        </aside>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
