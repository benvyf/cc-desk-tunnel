import { useEffect, useState } from 'react';
import { defaultFontSizes, fontSizeOptions, validFontSize } from './fontSizes.ts';
import type { FontSizes } from './fontSizes.ts';
import { setPrefs, usePrefs } from './prefs.ts';

function FontSizeInput({
  kind,
  label,
  value,
}: {
  kind: keyof FontSizes;
  label: string;
  value: number;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const { min, max } = fontSizeOptions[kind];
  return (
    <span className="font-size-control">
      <input
        type="number"
        aria-label={label}
        aria-describedby={`font-size-${kind}-detail`}
        min={min}
        max={max}
        step={1}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = event.target.valueAsNumber;
          if (validFontSize(kind, next))
            setPrefs((prefs) => ({ ...prefs, fontSizes: { ...prefs.fontSizes, [kind]: next } }));
        }}
        onBlur={() => setDraft(String(value))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
      />
      <span aria-hidden="true">px</span>
    </span>
  );
}

export default function FontSizeSettings() {
  const { fontSizes } = usePrefs();
  return (
    <div className="card font-size-settings">
      {(
        [
          ['interface', '界面字号', '调整界面文字的基础字号，12–20 px'],
          ['code', '代码字体大小', '调整聊天代码和工具代码内容的字号，10–24 px'],
        ] as const
      ).map(([kind, label, detail]) => (
        <div className="setting-row" key={kind}>
          <span>
            <strong>{label}</strong>
            <small id={`font-size-${kind}-detail`}>{detail}</small>
          </span>
          <FontSizeInput kind={kind} label={label} value={fontSizes[kind]} />
        </div>
      ))}
      <div className="setting-row">
        <span>
          <small>默认：界面 14 px，代码 13 px</small>
        </span>
        <button
          type="button"
          className="button ghost"
          disabled={
            fontSizes.interface === defaultFontSizes.interface &&
            fontSizes.code === defaultFontSizes.code
          }
          onClick={() => setPrefs((prefs) => ({ ...prefs, fontSizes: { ...defaultFontSizes } }))}
        >
          恢复默认字号
        </button>
      </div>
    </div>
  );
}
