import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateConfig } from '../apps/update-service/src/config.ts';
import { PasswordAuth } from '../apps/update-service/src/password-auth.ts';

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config')
    throw new Error('Expected --config FILE');
  if (process.platform !== 'win32' && process.getuid() !== 0)
    throw new Error('Root SSH access required');
  const config = validateConfig(JSON.parse(await readFile(process.argv[3], 'utf8')));
  const auth = new PasswordAuth(join(config.dataDir, 'private'));
  const token = await auth.issueSetup();
  // The fragment stays in the browser and is never sent in HTTP access logs.
  console.log(config.origin + '/cc-updates/admin/#setup=' + token);
} catch {
  console.error(
    'Unable to create password setup link; check root SSH access and service configuration.',
  );
  process.exitCode = 1;
}
