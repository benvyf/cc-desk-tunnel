import type { NativeCapabilities } from '@cc-desk-tunnel/protocol';

type Model = Pick<NativeCapabilities['models'][number], 'value' | 'displayName' | 'resolvedModel'>;

// SDK aliases such as `opus` can have a family-only display name and a versioned resolved ID.
function versionedName(id: string | null | undefined) {
  const current = id?.match(
    /^claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d{1,2})(?!\d))?(?=$|[-[(])/i,
  );
  const legacy = id?.match(/^claude-(\d+)(?:[.-](\d{1,2})(?!\d))?-(opus|sonnet|haiku)(?=$|[-[(])/i);
  const family = current?.[1] ?? legacy?.[3];
  if (!family) return null;
  const major = current?.[2] ?? legacy?.[1];
  const minor = current?.[3] ?? legacy?.[2];
  return {
    family: family.toLowerCase(),
    label: `${family[0].toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ''}`,
  };
}

export function modelName(model?: Model, fallback?: string | null): string {
  const name = model?.displayName.trim() ?? '';
  const short = name.match(/^(?:Claude\s+)?(Opus|Sonnet|Haiku)(?=$|[\s(])/i);
  const suffix = short ? name.slice(short[0].length) : '';
  if (short && /^\s+\d/.test(suffix)) return name;
  const family = short?.[1].toLowerCase();
  for (const id of [model?.resolvedModel, fallback, model?.value]) {
    const parsed = versionedName(id);
    if (!parsed || (family && parsed.family !== family)) continue;
    if (family) return parsed.label + suffix;
    if (!name || model?.value === 'default' || name === id) return parsed.label;
  }
  return name || fallback || model?.value || '原生默认';
}
