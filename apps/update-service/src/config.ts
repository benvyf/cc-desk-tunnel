import { createPublicKey } from 'node:crypto';
import { isAbsolute, parse, resolve } from 'node:path';
import { monitorNodePattern } from '../../../packages/protocol/src/account-monitor.ts';

export type UpdateConfig = {
  origin: string;
  dataDir: string;
  port: number;
  adminName: string;
  adminTokenSha256: string;
  trustedKeys: Record<string, string>;
  monitorNodes?: Record<string, string>;
};

export function validateConfig(value: unknown): UpdateConfig {
  const fail = () => {
    throw new Error('Invalid update-service configuration.');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const c = value as Record<string, unknown>;
  const fields = ['origin', 'dataDir', 'port', 'adminName', 'adminTokenSha256', 'trustedKeys'];
  if (
    Object.keys(c).some((k) => ![...fields, 'monitorNodes'].includes(k)) ||
    !fields.every((k) => Object.hasOwn(c, k))
  )
    return fail();
  if (typeof c.origin !== 'string' || typeof c.dataDir !== 'string' || !isAbsolute(c.dataDir))
    return fail();
  if (resolve(c.dataDir) === parse(resolve(c.dataDir)).root) return fail();
  const origin = new URL(c.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== c.origin ||
    origin.username ||
    origin.password
  )
    return fail();
  if (!Number.isInteger(c.port) || Number(c.port) < 1024 || Number(c.port) > 65535) return fail();
  if (typeof c.adminName !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(c.adminName)) return fail();
  if (typeof c.adminTokenSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.adminTokenSha256))
    return fail();
  if (!c.trustedKeys || typeof c.trustedKeys !== 'object' || Array.isArray(c.trustedKeys))
    return fail();
  const entries = Object.entries(c.trustedKeys);
  if (entries.length < 1 || entries.length > 8) return fail();
  for (const [keyId, pem] of entries) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) ||
      typeof pem !== 'string' ||
      pem.length > 2048 ||
      !pem.startsWith('-----BEGIN PUBLIC KEY-----')
    )
      return fail();
    if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') return fail();
  }
  if (Object.hasOwn(c, 'monitorNodes')) {
    if (!c.monitorNodes || typeof c.monitorNodes !== 'object' || Array.isArray(c.monitorNodes))
      return fail();
    const nodes = Object.entries(c.monitorNodes);
    if (
      nodes.length > 64 ||
      nodes.some(
        ([id, hash]) =>
          !monitorNodePattern.test(id) ||
          typeof hash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(hash) ||
          hash === c.adminTokenSha256,
      )
    )
      return fail();
    if (new Set(nodes.map(([, hash]) => hash)).size !== nodes.length) return fail();
  }
  return Object.freeze({
    ...c,
    ...(c.monitorNodes ? { monitorNodes: Object.freeze({ ...c.monitorNodes }) } : {}),
    trustedKeys: Object.freeze({ ...c.trustedKeys }),
  }) as UpdateConfig;
}
