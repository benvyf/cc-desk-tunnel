// Production image bootstrap: ordinary service.env values cannot disable the managed gate.
import { readFileSync } from 'node:fs';
import { moderationConfig } from './moderation.ts';
import { assertNativeTerminalPolicy } from './native-terminal-policy.ts';

const directory = '/etc/claude-code';
const nodePath = directory + '/moderation-node.json';
const executable = '/opt/runtime/cli/bin/claude';
const disk = {
  read: (path: string) => readFileSync(path, 'utf8'),
  policy: () => assertNativeTerminalPolicy(executable),
};

export function enforceManagedDeployment(env: NodeJS.ProcessEnv, io = disk) {
  // Check the real mount, not a user-writable setting that merely claims read-only.
  const mounted = io
    .read('/proc/self/mountinfo')
    .split('\n')
    .some((line) => {
      const fields = line.split(' ');
      return fields[4] === directory && fields[5]?.split(',').includes('ro');
    });
  if (!mounted) throw new Error('Managed Claude directory must be mounted read-only');
  try {
    io.policy(); // Ownership/policy checks only; never executes Claude at service startup.
  } catch {
    throw new Error('Required administrator native policy is invalid');
  }
  try {
    moderationConfig(JSON.parse(io.read(nodePath)));
  } catch {
    // Parser errors may echo credential JSON. Keep startup logs free of those values.
    throw new Error('Managed node configuration is invalid');
  }
  env.PROXY_ADAPTER = 'claude-code';
  env.PROXY_MODERATION_CONFIG = nodePath;
  env.PROXY_NATIVE_TERMINAL_REVIEW = '1';
  env.CLAUDE_PATH = executable;
}
