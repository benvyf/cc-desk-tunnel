import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishDifferential } from './publish-managed-differential.mjs';

// Legacy releases keep their existing publication flow. Once a source includes
// the differential SDK, its sidecars are mandatory before activating its feed.
export async function prepareDifferential(args, publisher = publishDifferential) {
  if (!args.source || args.state === 'empty') return null;
  const manifest = JSON.parse(await readFile(join(args.source, 'apps/desktop/package.json')));
  if (!manifest.dependencies?.['electron-updater']) return null;
  try {
    const contract = await lstat(
      join(args.source, 'apps/desktop/electron/managed-differential-contract.cjs'),
    );
    assert(contract.isFile() && !contract.isSymbolicLink());
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  assert(args.artifact);
  const blockmap = args.blockmap || args.artifact + '.blockmap';
  const info = await lstat(blockmap);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  return publisher({
    source: args.source,
    index: args.index,
    artifact: args.artifact,
    blockmap,
    'private-key': args['private-key'],
    'key-id': args['key-id'],
    'public-root': args['public-root'] || '/srv/cc-update-service/public',
  });
}
