import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  excluded.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  excluded.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function publicBrowserAddress(address: string) {
  const family = isIP(address);
  if (!family || address.includes('%')) return false;
  if (family === 4) return !excluded.check(address, 'ipv4');
  // Deliberately exclude mapped/translation addresses even when they embed a public IPv4.
  return globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
}

export function browserProxyHost(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 253 ||
    isIP(value) ||
    /[^a-zA-Z0-9.-]/.test(value)
  )
    throw new Error('Invalid browser proxy host');
  const host = value.toLowerCase();
  if (
    !host.includes('.') ||
    !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error('Invalid browser proxy host');
  return host;
}

export type BrowserLookup = (host: string) => Promise<{ address: string; family: number }[]>;
export type BrowserTarget = { address: string; family: 4 | 6; port: 443 };
const systemLookup: BrowserLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export async function resolveBrowserTarget(
  host: unknown,
  port: unknown,
  allowed: ReadonlySet<string>,
  lookup: BrowserLookup = systemLookup,
): Promise<BrowserTarget> {
  const name = browserProxyHost(host);
  if (port !== 443 || !allowed.has(name)) throw new Error('Browser target denied');
  const answers = await lookup(name);
  if (
    !answers.length ||
    answers.some(
      ({ address, family }) => !publicBrowserAddress(address) || isIP(address) !== family,
    )
  )
    throw new Error('Browser target denied');
  const first = answers.find((answer) => answer.family === 4) ?? answers[0];
  // Callers must dial this numeric address, not resolve the original hostname a second time.
  return { address: first.address, family: first.family as 4 | 6, port: 443 };
}
