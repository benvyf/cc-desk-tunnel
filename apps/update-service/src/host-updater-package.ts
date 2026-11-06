import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { UpdateConfig } from './config.ts';

export async function hostInstaller(config: UpdateConfig) {
  const paths = {
    'agent.py': '../web/host-updater-agent.py',
    'server-upgrade.cjs': '../web/server-upgrade.cjs',
    'base/upgrade-runtime-base.py': '../../../scripts/upgrade-runtime-base.py',
    'base/upgrade-message-review.py': '../../../scripts/upgrade-message-review.py',
    'base/install-cc-space-037.py': '../../../scripts/install-cc-space-037.py',
    'base/server-bootstrap.py': '../web/server-bootstrap.py',
    'base/fresh-install.py': '../web/fresh-install-host-base.py',
  };
  const entries = await Promise.all(
    Object.entries(paths).map(async ([name, path]) => [
      name,
      (await readFile(new URL(path, import.meta.url))).toString('base64'),
    ]),
  );
  const bundle = deflateSync(
    JSON.stringify({
      origin: config.origin,
      keys: config.trustedKeys,
      files: Object.fromEntries(entries),
    }),
  ).toString('base64');
  const template = await readFile(
    new URL('../web/host-updater-install.py', import.meta.url),
    'utf8',
  );
  return Buffer.from(template.replace('__HOST_BUNDLE__', bundle));
}

export function hostEnrollmentCommand(
  origin: string,
  installer: Buffer,
  nodeId: string,
  code: string,
) {
  const sha = createHash('sha256').update(installer).digest('hex');
  const text = `import hashlib,pathlib,subprocess,tempfile,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
with urllib.request.build_opener(NoRedirect).open(${JSON.stringify(origin + '/cc-updates/admin/host-updater-install.py')},timeout=30) as response:data=response.read(262145)
if len(data)>262144 or hashlib.sha256(data).hexdigest()!=${JSON.stringify(sha)}:raise SystemExit('Host installer checksum mismatch')
with tempfile.TemporaryDirectory(prefix='cc-host-enroll-') as directory:
 path=pathlib.Path(directory)/'install.py';path.write_bytes(data)
 subprocess.run(['python3',str(path),'--node',${JSON.stringify(nodeId)},'--code',${JSON.stringify(code)}],check=True)
`;
  return "sudo python3 -c '" + text.replaceAll("'", "'\"'\"'") + "'";
}
