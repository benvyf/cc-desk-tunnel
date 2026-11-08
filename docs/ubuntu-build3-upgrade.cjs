const http = require('node:http'),
  https = require('node:https');
const fs = require('node:fs'),
  tls = require('node:tls');
const target = {
  build: 3,
  sha256: '55bc3834b8f4be34974b203edc360e6b4ea2a17abedf36af6acfba0b9eee713c',
};
const direct = process.env.PROXY_TLS_MODE !== 'reverse-proxy';
if (!process.env.PROXY_TOKEN) throw Error('Service authentication environment is missing.');
function request(route, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = (direct ? https : http).request(
      {
        host: '127.0.0.1',
        port: Number(process.env.PROXY_PORT || 8787),
        path: '/cc-managed/server/v1/' + route,
        method: payload ? 'POST' : 'GET',
        headers: {
          authorization: 'Bearer ' + process.env.PROXY_TOKEN,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
        ...(direct
          ? {
              ca: [...tls.rootCertificates, fs.readFileSync(process.env.PROXY_TLS_CERT)],
              allowPartialTrustChain: true,
              servername: process.env.PROXY_CERT_NAME,
            }
          : {}),
      },
      (res) => {
        let text = '';
        res.on('data', (part) => {
          text += part;
        });
        res.on('end', () => {
          try {
            const value = JSON.parse(text);
            if (res.statusCode < 200 || res.statusCode >= 300)
              reject(
                Error(
                  'Management HTTP ' + res.statusCode + ': ' + (value.error || 'request rejected'),
                ),
              );
            else resolve(value);
          } catch {
            reject(Error('Invalid management response'));
          }
        });
      },
    );
    req.setTimeout(180000, () => req.destroy(Error('Management request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}
(async () => {
  const start = Date.now();
  const progress = setInterval(
    () =>
      console.log(
        'RUNNING: ' + Math.floor((Date.now() - start) / 1000) + 's; keep this console open.',
      ),
    15000,
  );
  try {
    console.log('1/3 Checking the signed Build 3 target (no Claude/provider requests)...');
    const status = await request('status');
    if (status.current.build === target.build && status.current.sha256 === target.sha256) {
      console.log('SUCCESS: Build 3 is already installed.');
      return;
    }
    const check = await request('check', { clientProtocol: 20 });
    if (
      !check.compatible ||
      check.reason !== 'available' ||
      check.candidate?.build !== target.build ||
      check.candidate?.sha256 !== target.sha256
    )
      throw Error(
        'The current signed release is not the pinned, compatible Build 3. No installation requested.',
      );
    console.log('2/3 Requesting the managed upgrade; active connections/tasks will be rejected...');
    await request('install', { clientProtocol: 20, confirmed: true, ...target });
    console.log('3/3 Waiting for readiness and commit; keep this console open...');
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      let next;
      try {
        next = await request('status');
      } catch {
        continue;
      }
      if (
        next.phase === 'committed' &&
        next.current.build === target.build &&
        next.current.sha256 === target.sha256
      ) {
        console.log('SUCCESS: Linux Build 3 / protocol 20 is installed and committed.');
        return;
      }
      if (['failed', 'rolled-back'].includes(next.phase))
        throw Error('Upgrade did not commit; the managed service reported ' + next.phase + '.');
    }
    throw Error('Status wait ended. Check managed status before retrying; do not rerun bootstrap.');
  } finally {
    clearInterval(progress);
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
