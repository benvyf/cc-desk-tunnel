import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SegmentedControl } from '../../src/SegmentedControl.tsx';
import { FileCode, Folder, MessageSquare, Settings } from '../../src/icons.tsx';

export function mount() {
  const root = document.createElement('main');
  root.style.cssText = 'padding:24px;display:grid;gap:24px;max-width:700px';
  document.body.replaceChildren(root);
  function Demo() {
    const [value, setValue] = useState('chat');
    const [many, setMany] = useState(false);
    const [stress, setStress] = useState(false);
    const options = [
      { value: 'chat', label: 'Chat', icon: <MessageSquare /> },
      { value: 'projects', label: 'Projects', icon: <Folder /> },
      { value: 'artifacts', label: 'Artifacts', icon: <FileCode />, disabled: true },
      { value: 'settings', label: 'Settings', icon: <Settings /> },
      ...(many ? [{ value: 'quota', label: '本期 Sonnet 每周额度' }] : []),
      ...(stress
        ? Array.from({ length: 5 }, (_, index) => ({
            value: `extra-${index}`,
            label: `本期模型 ${index} 每周额度`,
          }))
        : []),
    ];
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          root.dataset.submitted = 'true';
        }}
        style={{ display: 'grid', gap: 20 }}
      >
        <div id="resizer" style={{ width: 420, maxWidth: '100%' }}>
          <SegmentedControl label="导航" value={value} options={options} onChange={setValue} />
        </div>
        <SegmentedControl
          label="展示"
          role="radiogroup"
          value={value}
          options={options}
          onChange={setValue}
        />
        <details>
          <summary>展开示例</summary>
          <SegmentedControl label="隐藏导航" value={value} options={options} onChange={setValue} />
        </details>
        <button type="button" onClick={() => setMany(!many)}>
          动态选项
        </button>
        <button type="button" onClick={() => setStress(!stress)}>
          更多选项
        </button>
      </form>
    );
  }
  createRoot(root).render(<Demo />);
}
