import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { UpdateConfig } from './config.ts';

export async function hostInstaller(config: UpdateConfig) {
  const names = [
    'host-platform.py',
    'host-platform-entry.py',
    'host-bootstrap.py',
    'host-bootstrap-entry.py',
    'host-operations.py',
  ];
  // Git exports LF code for the signed application bridge. Keep its fixed
  // bootstrap hashes identical when this factory runs from a CRLF checkout.
  const codeBytes = async (name: string) =>
    Buffer.from(
      (await readFile(new URL('../web/' + name, import.meta.url), 'utf8')).replaceAll('\r\n', '\n'),
      'utf8',
    );
  const entries = await Promise.all(
    names.map(async (name) => [name, await codeBytes(name)] as const),
  );
  const probe = await codeBytes('server-upgrade.cjs');
  const bundle = deflateSync(
    JSON.stringify({
      origin: config.origin,
      keys: config.trustedKeys,
      sources: Object.fromEntries(entries.map(([name, bytes]) => [name, bytes.toString('base64')])),
      hashes: Object.fromEntries(
        entries.map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]),
      ),
      probe: probe.toString('base64'),
      probeSha256: createHash('sha256').update(probe).digest('hex'),
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
