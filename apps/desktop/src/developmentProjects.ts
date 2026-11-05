import type { Session } from '@cc-desk-tunnel/protocol';
import { folderName, pathKey } from './paths.ts';

// The service scopes remote device identities; local preferences keep their existing path keys.
export const projectIdentity = (scope: string, deviceId: string, path: string) =>
  JSON.stringify([scope, deviceId, pathKey(path)]);
export const projectPreferenceKey = (scope: string, deviceId: string | undefined, path: string) =>
  deviceId ? `remote:${projectIdentity(scope, deviceId, path)}` : pathKey(path);

export type TerminalProject = {
  key: string;
  path: string;
  name: string;
  deviceId: string;
  deviceName: string;
  source: Session;
};
export function terminalProjects(
  sessions: Session[],
  scope: string,
  active?: Session,
): TerminalProject[] {
  const groups = new Map<string, TerminalProject>();
  for (const source of sessions) {
    if (!source.device) continue;
    const key = projectIdentity(scope, source.device.id, source.projectPath);
    const previous = groups.get(key);
    if (
      !previous ||
      source.updatedAt > previous.source.updatedAt ||
      (source.updatedAt === previous.source.updatedAt && source.id < previous.source.id)
    )
      groups.set(key, {
        key,
        path: source.projectPath,
        name: folderName(source.projectPath),
        deviceId: source.device.id,
        deviceName: source.device.name,
        source,
      });
  }
  if (active?.device) {
    const current = groups.get(projectIdentity(scope, active.device.id, active.projectPath));
    if (current) current.source = active;
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.source.id === active?.id) - Number(a.source.id === active?.id) ||
      b.source.updatedAt.localeCompare(a.source.updatedAt) ||
      a.key.localeCompare(b.key),
  );
}
