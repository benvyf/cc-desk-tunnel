export function serviceJson(
  config: { url: string; fingerprint: string; token: string },
  method: string,
  path: string,
  body?: unknown,
  resolveProxy?: (url: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<unknown>;
