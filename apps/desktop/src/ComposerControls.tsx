import Presence from './Presence.tsx';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Check, RotateCcw } from './icons.tsx';
import { usePrefs } from './prefs.ts';
import { quotaFigures } from './quota.ts';
import type {
  Effort,
  NativeCapabilities,
  NativeMetrics,
  NativeSession,
} from '@cc-desk-tunnel/protocol';
import ContextMeter from './ContextMeter.tsx';
import { IconButton } from './ui.tsx';
import { usePopupBounds } from './usePopupBounds.ts';
import EffortSlider from './EffortSlider.tsx';
import { effortNames } from './modelDefaults.ts';
import { modelName } from './modelName.ts';

export default function ComposerControls({
  model,
  effort,
  capabilities,
  nativeSession,
  metrics,
  openAccount,
  disabled,
  configure,
  refresh,
  refreshing,
  canRefreshModels,
}: {
  model: string | null;
  effort: Effort | null;
  capabilities: NativeCapabilities | null;
  nativeSession: NativeSession | null;
  metrics: NativeMetrics | null;
  openAccount: () => void;
  disabled: boolean;
  configure: (values: { model?: string | null; effort?: Effort | null }) => Promise<void>;
  refresh: () => void;
  refreshing: boolean;
  canRefreshModels: boolean;
}) {
  const [open, setOpen] = useState(false);
  // With the strip under the input box switched on, the ring is shown there instead.
  const barShowsContext = usePrefs().sessionBar.enabled;
  const container = useRef<HTMLDivElement>(null);
  usePopupBounds(container, '.model-menu', open);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  // The menu opens on the effort slider; the list of models is one step further in.
  const [choosing, setChoosing] = useState(false);
  const [preview, setPreview] = useState<Effort | null>(null);
  const chosen =
    capabilities?.models.find((row) => row.value === (model ?? 'default')) ??
    capabilities?.models.find((row) => row.resolvedModel === (model ?? nativeSession?.model));
  const levels = chosen?.supportedEffortLevels ?? [];
  const actual = nativeSession?.effort;
  const shownEffort = preview ?? effort ?? actual;
  const label = modelName(
    chosen,
    model === chosen?.value ? (nativeSession?.model ?? model) : (model ?? nativeSession?.model),
  );
  useEffect(() => {
    setPreview(null);
  }, [model, open]);
  const quota = usePrefs().quota ? quotaFigures(metrics?.rateLimits) : [];
  const fullest = Math.max(0, ...quota.map((figure) => figure.used));
  return (
    <div className="composer-controls" ref={container}>
      {quota.length > 0 && (
        <button
          type="button"
          className={`quota-note ${fullest >= 90 ? 'danger' : fullest >= 70 ? 'warn' : ''}`}
          aria-label="额度已用"
          title={[
            ...quota.map(
              (figure) =>
                `${figure.label}额度已用 ${figure.used}%${
                  figure.resetsAt
                    ? `，${new Date(figure.resetsAt).toLocaleString('zh-CN')} 重置`
                    : ''
                }`,
            ),
            '点击查看账号与额度',
          ].join('\n')}
          onClick={openAccount}
        >
          {quota.map((figure) => `${figure.label} ${figure.used}%`).join(' · ')}
        </button>
      )}
      {!barShowsContext && <ContextMeter metrics={metrics} />}
      <div className="model-control">
        <button
          type="button"
          className="model-trigger"
          disabled={disabled}
          aria-label="模型与推理强度"
          title={label}
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
            setChoosing(false);
          }}
        >
          <span>{label}</span>
          <small>{effort ? effortNames[effort] : actual ? effortNames[actual] : '默认'}</small>
          <ChevronDown />
        </button>
        <Presence>
          {open && (
            <div className="model-menu" role="dialog" aria-label="模型与推理强度">
              <div className="effort-view" hidden={choosing}>
                <div className="effort-heading">
                  <strong>{shownEffort ? effortNames[shownEffort] : '原生默认'}</strong>
                  <IconButton
                    title="恢复默认推理强度"
                    disabled={disabled}
                    onClick={() => {
                      setPreview(null);
                      void configure({ effort: null });
                    }}
                  >
                    <RotateCcw />
                  </IconButton>
                </div>
                <button type="button" className="model-current" onClick={() => setChoosing(true)}>
                  {label}
                  <ChevronRight />
                </button>
                {levels.length > 0 && (
                  <EffortSlider
                    key={model ?? 'default'}
                    levels={levels}
                    value={effort ?? actual ?? null}
                    disabled={disabled}
                    onPreview={setPreview}
                    onCommit={(value) => configure({ effort: value })}
                  />
                )}
                {levels.length > 0 && (
                  <div className="effort-ticks">
                    {levels.map((level, index) => (
                      <button
                        key={level}
                        type="button"
                        tabIndex={-1}
                        disabled={disabled}
                        className={level === shownEffort ? 'current' : undefined}
                        style={
                          {
                            '--at': index / Math.max(1, levels.length - 1),
                          } as CSSProperties
                        }
                        onClick={() => void configure({ effort: level })}
                      >
                        {effortNames[level]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {choosing && (
                <>
                  <button type="button" className="model-back" onClick={() => setChoosing(false)}>
                    <ArrowLeft />
                    选择模型
                  </button>
                  <div className="model-options" role="listbox" aria-label="模型">
                    <button
                      type="button"
                      role="option"
                      disabled={disabled}
                      aria-selected={model === null}
                      onClick={() => {
                        void configure({ model: null, effort: null });
                        setOpen(false);
                      }}
                    >
                      <span>默认模型</span>
                      {model === null && <Check />}
                    </button>
                    {capabilities?.models
                      .filter((row) => row.value !== 'default')
                      .map((row) => (
                        <button
                          type="button"
                          role="option"
                          disabled={disabled}
                          aria-selected={model !== null && chosen?.value === row.value}
                          key={row.value}
                          onClick={() => {
                            void configure({ model: row.value, effort: null });
                            setOpen(false);
                          }}
                        >
                          <span>
                            {modelName(row)}
                            {row.resolvedModel && <small>{row.resolvedModel}</small>}
                            <small>{row.description}</small>
                          </span>
                          {model !== null && chosen?.value === row.value && <Check />}
                        </button>
                      ))}
                  </div>
                  <button
                    type="button"
                    className="model-back"
                    disabled={disabled || refreshing || !canRefreshModels}
                    title={canRefreshModels ? undefined : '有会话正在运行，结束后可刷新'}
                    onClick={refresh}
                  >
                    <RotateCcw />
                    {refreshing ? '正在刷新模型列表…' : '刷新模型列表'}
                  </button>
                </>
              )}
            </div>
          )}
        </Presence>
      </div>
    </div>
  );
}
