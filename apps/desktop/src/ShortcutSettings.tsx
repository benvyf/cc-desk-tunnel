import { Fragment, useState } from 'react';
import { setPrefs, usePrefs } from './prefs.ts';
import { actions, comboOf, keyFor, show, usable } from './shortcuts.ts';
import type { Action } from './shortcuts.ts';
import { Button, Switch } from './ui.tsx';

// Fixed keys of the terminal window. Each entry lists alternatives; each alternative is shown key by key, in keycaps
// like the fixed action above.
const terminalShortcuts: { name: string; detail?: string; combos: string[][] }[] = [
  { name: '新建同项目终端', combos: [['Ctrl', 'Shift', 'KeyT']] },
  { name: '打开或关闭终端菜单', combos: [['Ctrl', 'Shift', 'Space']] },
  { name: '下一个终端标签', combos: [['Ctrl', 'Tab']] },
  { name: '上一个终端标签', combos: [['Ctrl', 'Shift', 'Tab']] },
  {
    name: '跳到上一条提问',
    detail: '滚动模式下可用；整屏模式中这组按键交给 Claude',
    combos: [['Ctrl', 'Shift', 'ArrowUp']],
  },
  {
    name: '跳到下一条提问',
    detail: '滚动模式下可用；没有更后的提问时回到底部',
    combos: [['Ctrl', 'Shift', 'ArrowDown']],
  },
  {
    name: '复制选中的文字',
    detail: '没有选中文字时，Ctrl+C 仍发给 Claude 用来中断',
    combos: [
      ['Ctrl', 'KeyC'],
      ['Ctrl', 'Shift', 'KeyC'],
    ],
  },
  {
    name: '粘贴',
    combos: [
      ['Ctrl', 'KeyV'],
      ['Ctrl', 'Shift', 'KeyV'],
    ],
  },
];

export default function ShortcutSettings() {
  const prefs = usePrefs();
  const { enabled } = prefs.shortcuts;
  // The action whose next key press becomes its shortcut.
  const [recording, setRecording] = useState<Action | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const set = (action: Action, combo: string) =>
    setPrefs((value) => ({
      ...value,
      shortcuts: { ...value.shortcuts, keys: { ...value.shortcuts.keys, [action]: combo } },
    }));
  const stop = () => {
    setRecording(null);
    setFailure(null);
  };
  const listed = actions.filter((action) => !action.desktop || window.desktop);
  return (
    <section className="page" aria-label="快捷键">
      <div className="page-body">
        <h1 className="page-title">快捷键</h1>
        <p className="muted">
          界面快捷键只在本窗口处于前台时生效，不向系统注册全局热键；原生终端和对话框使用各自的按键操作。
        </p>
        <div className="card">
          <div className="setting-row">
            <span>
              <strong>启用快捷键</strong>
              <small>控制界面组合键和停止回答，菜单里的功能照常可用</small>
            </span>
            <Switch
              label="启用快捷键"
              checked={enabled}
              onChange={(value) => {
                stop();
                setPrefs((current) => ({
                  ...current,
                  shortcuts: { ...current.shortcuts, enabled: value },
                }));
              }}
            />
          </div>
        </div>
        <h2 className="page-heading">固定操作</h2>
        <div className="card">
          <div className="setting-row">
            <span>
              <strong>停止当前回答</strong>
              <small>
                500 毫秒内连按两次，仅停止焦点所在会话；菜单、输入法和终端中的 Esc 保持原用途。
              </small>
            </span>
            {/* Keycaps, as the combinations below are shown. */}
            <span className="key-combo" aria-label="Esc 连按两次">
              <kbd className="keycap">Esc</kbd>
              <kbd className="keycap">Esc</kbd>
            </span>
          </div>
        </div>
        {window.desktop && (
          <>
            <h2 className="page-heading" id="terminal-shortcuts-heading">
              终端窗口
            </h2>
            <p className="muted" id="terminal-shortcuts-description">
              固定快捷键，不支持修改，也不受上方开关影响。仅在终端区域内生效，输入法组合输入期间不触发。
            </p>
            <div
              className="card"
              role="group"
              aria-labelledby="terminal-shortcuts-heading"
              aria-describedby="terminal-shortcuts-description"
            >
              {terminalShortcuts.map(({ name, detail, combos }) => (
                <div className="setting-row" key={name}>
                  <span>
                    <strong>{name}</strong>
                    {detail && <small>{detail}</small>}
                  </span>
                  <span
                    className="key-combo"
                    aria-label={combos.map((keys) => show(keys.join('+'))).join(' 或 ')}
                  >
                    {combos.map((keys, index) => (
                      <Fragment key={keys.join('+')}>
                        {index > 0 && (
                          <span className="key-or" aria-hidden="true">
                            或
                          </span>
                        )}
                        {keys.map((key) => (
                          <kbd className="keycap" key={key} aria-hidden="true">
                            {show(key)}
                          </kbd>
                        ))}
                      </Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        <h2 className="page-heading">组合键</h2>
        <p className="muted">
          点一项后按下新的组合键（需要包含 Ctrl、Alt 或 Command，或是功能键）；按 Esc 取消，按
          Backspace 去掉这一项的快捷键。
        </p>
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
        <div className="card">
          {listed.map(({ id, name }) => {
            const combo = keyFor(prefs, id);
            return (
              <div className="setting-row" key={id}>
                <span>
                  <strong>{name}</strong>
                </span>
                <button
                  type="button"
                  className={`key-button ${recording === id ? 'recording' : ''}`}
                  aria-label={`修改快捷键：${name}`}
                  disabled={!enabled}
                  onClick={() => {
                    setFailure(null);
                    setRecording(recording === id ? null : id);
                  }}
                  onBlur={() => recording === id && stop()}
                  onKeyDown={(event) => {
                    if (recording !== id || event.key === 'Tab') return;
                    // The press is this box's alone: it must not run the shortcut it may already be.
                    event.preventDefault();
                    if (event.key === 'Escape') return stop();
                    if (event.key === 'Backspace' || event.key === 'Delete') {
                      set(id, '');
                      return stop();
                    }
                    const pressed = comboOf(event);
                    if (!pressed) return;
                    if (!usable(pressed))
                      return setFailure(
                        `${show(pressed)} 会妨碍正常输入；请加上 Ctrl、Alt 或 Command。`,
                      );
                    const taken = listed.find(
                      (other) => other.id !== id && keyFor(prefs, other.id) === pressed,
                    );
                    if (taken) return setFailure(`${show(pressed)} 已被“${taken.name}”使用。`);
                    set(id, pressed);
                    stop();
                  }}
                >
                  {recording === id ? '按下新的组合键…' : combo ? show(combo) : '未设置'}
                </button>
              </div>
            );
          })}
        </div>
        <Button
          variant="ghost"
          className="page-link-button"
          onClick={() => {
            stop();
            setPrefs((value) => ({ ...value, shortcuts: { ...value.shortcuts, keys: {} } }));
          }}
        >
          恢复默认组合键
        </Button>
      </div>
    </section>
  );
}
