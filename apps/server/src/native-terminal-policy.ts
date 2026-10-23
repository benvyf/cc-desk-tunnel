import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const nativeHookCommand =
  '/opt/runtime/node/bin/node /app/apps/server/src/native-moderation-hook.ts';
export const nativeHookEvents = [
  'UserPromptSubmit',
  'PostToolBatch',
  'UserPromptExpansion',
  'PreCompact',
];

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
  const policy = JSON.parse(readFileSync(file, 'utf8'));
  const expected = nativeTerminalPolicy();
  if (
    policy.disableAllHooks === true ||
    !nativeHookEvents.every(
      (event) =>
        Array.isArray(policy.hooks?.[event]) &&
        policy.hooks[event].some((group: unknown) =>
          isDeepStrictEqual(group, expected.hooks[event][0]),
        ),
    )
  )
    throw new Error('Required native review policy is not installed');
  return binary;
}

export function assertNativeTerminalReview(executable: string) {
  const binary = assertNativeTerminalPolicy(executable);
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (version !== '2.1.295 (Claude Code)')
    throw new Error('Native review requires the tested official CLI version');
  return binary;
}
