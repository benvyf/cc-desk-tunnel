import type { Effort, NativeCapabilities } from '@cc-desk-tunnel/protocol';

export const effortNames: Record<Effort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};
export const effortLevels = Object.keys(effortNames) as Effort[];
export type SessionDefaults = { model: string | null; effort: Effort | null };

export function readSessionDefaults(value: unknown): SessionDefaults {
  const saved = value && typeof value === 'object' ? (value as Partial<SessionDefaults>) : {};
  return {
    model:
      typeof saved.model === 'string' && saved.model.trim() && saved.model.length <= 200
        ? saved.model.trim()
        : null,
    effort: effortLevels.includes(saved.effort as Effort) ? (saved.effort as Effort) : null,
  };
}

export function sessionDefaultOptions(
  defaults: SessionDefaults,
  models?: NativeCapabilities['models'],
): SessionDefaults {
  if (!models?.length) return defaults;
  const chosen = models.find((row) => row.value === (defaults.model ?? 'default'));
  if (defaults.model && !chosen) return { model: null, effort: null };
  return {
    model: defaults.model,
    effort:
      defaults.effort && (!chosen || chosen.supportedEffortLevels.includes(defaults.effort))
        ? defaults.effort
        : null,
  };
}
