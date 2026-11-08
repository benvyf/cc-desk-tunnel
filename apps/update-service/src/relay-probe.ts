import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { connect } from 'node:tls';
import { publicIPv4 } from './relay-config.ts';
import { UpdateError } from './store.ts';

// Probe the SSH transport identity without passwords, private keys or remote commands.
export async function probeRelayHost(host: string, key: string): Promise<void> {
  publicIPv4(host);
  if (!/^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}=?$/.test(key))
    throw new UpdateError(400, '无效 SSH 主机身份。');
  const directory = await mkdtemp(join(tmpdir(), 'cc-relay-probe-'));
  try {
    const known = join(directory, 'known_hosts');
    await writeFile(known, `${host} ssh-ed25519 ${key}\n`, { mode: 0o600 });
    try {
      // OpenSSH verifies the key-exchange signature before user authentication. No
      // credential methods are enabled: reaching its final denial proves transport identity.
      await promisify(execFile)(
        'ssh',
        [
          '-F',
          'none',
          '-NT',
          '-p',
          '22',
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          `UserKnownHostsFile=${known}`,
          '-o',
          `GlobalKnownHostsFile=${known}`,
          '-o',
          'HostKeyAlgorithms=ssh-ed25519',
          '-o',
          'PubkeyAuthentication=no',
          '-o',
          'PasswordAuthentication=no',
          '-o',
          'KbdInteractiveAuthentication=no',
          '-o',
          'GSSAPIAuthentication=no',
          '-o',
          'HostbasedAuthentication=no',
          '-o',
          'PreferredAuthentications=none',
          '-o',
          'ConnectTimeout=6',
          '-o',
          'ConnectionAttempts=1',
          `ccdesk-relay@${host}`,
        ],
        {
          timeout: 8000,
          maxBuffer: 16384,
          windowsHide: true,
          env: { ...process.env, LC_ALL: 'C' },
        },
      );
      throw new UpdateError(409, '中转 SSH 不应允许无凭据登录，请检查配置。');
    } catch (error) {
      const failure = error as { code?: number; stderr?: string; killed?: boolean };
      const last = failure.stderr?.trim().split('\n').at(-1)?.trim();
      if (
        failure.code !== 255 ||
        failure.killed ||
        !last?.startsWith(`ccdesk-relay@${host}: Permission denied (`) ||
        !last.endsWith(').')
      )
        throw new UpdateError(
          502,
          '无法验证新 IP 的 SSH 主机身份，请检查地址、主机密钥及 SSH 端口。',
        );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The TLS pin is uniquely bound to the selected enrolled node before this fixed /health probe.
export async function probeRelayNode(url: string, fingerprint: string): Promise<void> {
  const target = new URL(url);
  publicIPv4(target.hostname);
  if (
    target.protocol !== 'wss:' ||
    target.username ||
    target.password ||
    !/^[a-f0-9]{64}$/i.test(fingerprint.replaceAll(':', ''))
  )
    throw new UpdateError(400, '无效节点验收目标。');
  return probePinnedHealth(url, fingerprint);
}

export async function probePinnedHealth(url: string, fingerprint: string): Promise<void> {
  const target = new URL(url);
  await new Promise<void>((resolve, reject) => {
    const socket = connect({
      host: target.hostname,
      port: Number(target.port || 443),
      rejectUnauthorized: false,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    const fail = () => finish(new UpdateError(502, '公网节点尚未通过证书和健康检查，将继续验证。'));
    const timer = setTimeout(fail, 8000);
    socket.on('error', fail);
    socket.once('secureConnect', () => {
      const observed = socket.getPeerCertificate().raw;
      if (
        !observed ||
        createHash('sha256').update(observed).digest('hex') !==
          fingerprint.replaceAll(':', '').toLowerCase()
      ) {
        fail();
        return;
      }
      const req = request(
        {
          host: target.hostname,
          port: Number(target.port || 443),
          method: 'GET',
          path: '/health',
          createConnection: () => socket,
          headers: { Connection: 'close', Host: target.host },
        },
        (res) => {
          let bytes = '';
          res.on('error', fail);
          res.on('data', (chunk) => {
            bytes += chunk;
            if (bytes.length > 8192) {
              res.destroy();
              fail();
            }
          });
          res.on('end', () => {
            try {
              const value = JSON.parse(bytes);
              if (
                res.statusCode !== 200 ||
                value.status !== 'ok' ||
                !Number.isSafeInteger(value.protocolVersion) ||
                value.protocolVersion < 1
              ) {
                fail();
                return;
              }
              finish();
            } catch {
              fail();
            }
          });
        },
      );
      req.on('error', fail);
      req.end();
    });
  });
}
