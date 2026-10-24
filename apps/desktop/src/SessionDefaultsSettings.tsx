import type { Effort, NativeCapabilities } from '@cc-desk-tunnel/protocol';
import { effortLevels, effortNames, sessionDefaultOptions } from './modelDefaults.ts';
import { setPrefs, usePrefs } from './prefs.ts';
import { modelName } from './modelName.ts';

export default function SessionDefaultsSettings({
  capabilities,
}: {
  capabilities: NativeCapabilities | null;
}) {
  const { sessionDefaults } = usePrefs();
  const models = capabilities?.models ?? [];
  const chosen = models.find((row) => row.value === (sessionDefaults.model ?? 'default'));
  const levels = chosen?.supportedEffortLevels ?? effortLevels;
  return (
    <>
      <h2 className="page-heading">新建会话默认值</h2>
      <div className="card session-defaults">
        <div className="setting-row">
          <span>
            <strong>默认模型</strong>
            <small>新建会话自动使用；已有会话和会话内的临时选择不受影响</small>
          </span>
          <select
            aria-label="默认模型"
            value={sessionDefaults.model ?? ''}
            onChange={(event) => {
              const model = event.target.value || null;
              setPrefs((prefs) => ({
                ...prefs,
                sessionDefaults: sessionDefaultOptions({ ...prefs.sessionDefaults, model }, models),
              }));
            }}
          >
            <option value="">跟随服务端默认</option>
            {sessionDefaults.model &&
              !models.some((row) => row.value === sessionDefaults.model) && (
                <option value={sessionDefaults.model}>
                  {modelName(undefined, sessionDefaults.model)}（已保存）
                </option>
              )}
            {models
              .filter((row) => row.value !== 'default')
              .map((row) => (
                <option key={row.value} value={row.value}>
                  {modelName(row)}
                </option>
              ))}
          </select>
        </div>
        <div className="setting-row">
          <span>
            <strong>默认推理强度</strong>
            <small>
              {chosen && !levels.length
                ? '所选模型不支持调整推理强度'
                : '仅应用到新建会话，按所选模型支持的档位生效'}
            </small>
          </span>
          <select
            aria-label="默认推理强度"
            disabled={levels.length === 0}
            value={sessionDefaults.effort ?? ''}
            onChange={(event) => {
              const effort = (event.target.value || null) as Effort | null;
              setPrefs((prefs) => ({
                ...prefs,
                sessionDefaults: { ...prefs.sessionDefaults, effort },
              }));
            }}
          >
            <option value="">跟随模型默认</option>
            {sessionDefaults.effort && !levels.includes(sessionDefaults.effort) && (
              <option value={sessionDefaults.effort}>
                {effortNames[sessionDefaults.effort]}（已保存）
              </option>
            )}
            {levels.map((level) => (
              <option key={level} value={level}>
                {effortNames[level]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {models.length === 0 && (
        <p className="muted">
          连接服务并打开一个会话后，可选择该服务提供的模型；已保存的默认值仍会保留。
        </p>
      )}
    </>
  );
}
