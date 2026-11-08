import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const nativeHookCommand =
  '/opt/runtime/node/bin/node /app/apps/server/src/native-moderation-hook.ts';
export const nativeHookEvents = ['UserPromptSubmit'];

export function nativeTerminalPolicy() {
  return {
    hooks: Object.fromEntries(
      nativeHookEvents.map((event) => [
        event,
        [
          {
            hooks: [
              {
                type: 'command',
                command: nativeHookCommand,
                timeout: 10,
                onFailure: 'block',
              },
            ],
          },
        ],
      ]),
    ),
  };
}

export function assertNativeReviewPolicy(policy: unknown) {
  const value = policy as {
    disableAllHooks?: boolean;
    hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
  } | null;
  const groups = value?.hooks?.UserPromptSubmit;
  if (
    value?.disableAllHooks === true ||
    !Array.isArray(groups) ||
    !groups.some((group) =>
      isDeepStrictEqual(group, nativeTerminalPolicy().hooks.UserPromptSubmit[0]),
    )
  )
    throw new Error('Required native review policy is not installed');
  // Reject stale CC registrations so large tool results never enter this hook.
  // Other administrator hooks remain independent of CC message moderation.
  for (const [event, old] of Object.entries(value?.hooks ?? {})) {
    if (event === 'UserPromptSubmit') continue;
    if (
      Array.isArray(old) &&
      old.some(
        (group) =>
          Array.isArray(group?.hooks) &&
          group.hooks.some(
            (hook) =>
              typeof hook?.command === 'string' &&
              (hook.command === nativeHookCommand ||
                hook.command.startsWith(nativeHookCommand + ' ')),
          ),
      )
    )
      throw new Error('Legacy CC review hooks must be removed before starting');
  }
}

// File and policy checks shared by startup and terminal opening; this function never runs Claude.
export function assertNativeTerminalPolicy(executable: string) {
  const binary = executable === 'claude' ? '/opt/runtime/cli/bin/claude' : executable;
  const file = '/etc/claude-code/managed-settings.json';
  for (const path of [
    file,
    '/etc/claude-code/moderation-node.json',
    '/app/apps/server/src/native-moderation-hook.ts',
    '/opt/runtime/node/bin/node',
    binary,
  ]) {
    const owner = statSync(path);
    if (!owner.isFile() || owner.uid !== 0 || owner.mode & 0o022)
      throw new Error('Native review files must be administrator owned');
  }
  assertNativeReviewPolicy(JSON.parse(readFileSync(file, 'utf8')));
  return binary;
}

export function assertNativeTerminalReview(executable: string) {
  const binary = assertNativeTerminalPolicy(executable);
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (version !== '2.1.295 (Claude Code)')
    throw new Error('Native review requires the tested official CLI version');
  return binary;
}
