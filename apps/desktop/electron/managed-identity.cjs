const { createHash, createPublicKey } = require('node:crypto');
const { realpathSync } = require('node:fs');
const path = require('node:path');

function validateIdentity(value) {
  const fields = [
    'product',
    'build',
    'channel',
    'origin',
    'trustedKeys',
    'appVersion',
    'protocol',
    'sourceCommit',
    'platform',
    'arch',
  ];
  if (
    !value ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('Invalid managed build identity');
  if (
    value.product !== 'cc-desk-tunnel-managed' ||
    !Number.isSafeInteger(value.build) ||
    value.build <= 0 ||
    !['pilot', 'stable'].includes(value.channel) ||
    value.platform !== 'win32' ||
    value.arch !== 'x64' ||
    !Number.isSafeInteger(value.protocol) ||
    value.protocol <= 0 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.appVersion) ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit)
  )
    throw new Error('Invalid managed build identity');
  const origin = new URL(value.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== value.origin ||
    origin.username ||
    origin.password
  )
    throw new Error('Expected fixed HTTPS origin');
  if (
    !value.trustedKeys ||
    Array.isArray(value.trustedKeys) ||
    !Object.keys(value.trustedKeys).length
  )
    throw new Error('Missing signing keys');
  for (const [id, pem] of Object.entries(value.trustedKeys)) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
      typeof pem !== 'string' ||
      !pem.startsWith('-----BEGIN PUBLIC KEY-----')
    )
      throw new Error('Invalid public signing key');
    if (createPublicKey(pem).asymmetricKeyType !== 'ed25519')
      throw new Error('Expected Ed25519 key');
  }
  return value;
}

function installationId(executable) {
  const directory = realpathSync
    .native(path.dirname(executable))
    .replaceAll('/', '\\')
    .toLowerCase();
  return createHash('sha256').update(directory).digest('hex');
}

module.exports = { validateIdentity, installationId };
