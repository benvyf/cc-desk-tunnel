import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, statSync, chownSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Run locally on the VPS as root. The output file contains only this node's credential.
const [privateDir, nodeId, endpoint, output] = process.argv.slice(2);
if (
  process.getuid?.() !== 0 ||
  !privateDir ||
  !output ||
  !/^[a-zA-Z0-9_-]{1,128}$/.test(nodeId ?? '')
)
  throw new Error('Expected root: private-directory node-id HTTPS-endpoint new-output-file');
const url = new URL(endpoint);
if (
  url.protocol !== 'https:' ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  url.pathname !== '/cc-updates/v1/moderation/check'
)
  throw new Error('Invalid endpoint.');
const path = join(resolve(privateDir), 'moderation-nodes.json');
let registry = {};
try {
  registry = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (Object.hasOwn(registry, nodeId))
  throw new Error('Node already provisioned; revoke explicitly before rotating.');
const token = randomBytes(32).toString('base64url');
registry[nodeId] = createHash('sha256').update(token).digest('hex');
writeFileSync(output, JSON.stringify({ nodeId, endpoint: url.href, token }) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
writeFileSync(path + '.next', JSON.stringify(registry) + '\n', { mode: 0o600 });
const owner = statSync(privateDir);
chownSync(path + '.next', owner.uid, owner.gid);
renameSync(path + '.next', path);
console.log('Node provisioned. Credential saved privately; not printed.');
