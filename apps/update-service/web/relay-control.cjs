// Executed only inside the selected local CC container by the root host agent.
const https = require('node:https'),
  fs = require('node:fs');
const direct = process.env.PROXY_TLS_MODE !== 'reverse-proxy';
const cert = direct
  ? new (require('node:crypto').X509Certificate)(fs.readFileSync(process.env.PROXY_TLS_CERT))
  : null;
if (!cert || !process.env.PROXY_TOKEN)
  throw Error('Relay control requires local pinned TLS and service identity');
if (relayAction === 'identity') {
  console.log(
    JSON.stringify({ fingerprint: cert.fingerprint256.replaceAll(':', '').toLowerCase() }),
  );
} else {
  if (!['enter', 'recover', 'leave'].includes(relayAction)) throw Error('Invalid relay operation');
  const request = https.request(
    {
      host: '127.0.0.1',
      port: Number(process.env.PROXY_PORT || 8787),
      path: '/cc-managed/server/v1/relay-' + (relayAction === 'recover' ? 'enter' : relayAction),
      method: 'POST',
      ca: [...require('node:tls').rootCertificates, fs.readFileSync(process.env.PROXY_TLS_CERT)],
      allowPartialTrustChain: true,
      servername: process.env.PROXY_CERT_NAME,
      checkServerIdentity: (_host, peer) =>
        peer.fingerprint256 === cert.fingerprint256
          ? undefined
          : Error('Local certificate differs'),
      headers: {
        authorization: 'Bearer ' + process.env.PROXY_TOKEN,
        ...(relayAction === 'recover' ? { 'x-cc-relay-recovery': 'disconnected' } : {}),
        ...(relayLease ? { 'x-cc-relay-lease': relayLease } : {}),
      },
    },
    (res) => {
      let bytes = '';
      res.on('data', (part) => {
        bytes += part;
        if (bytes.length > 4096) res.destroy(Error('Response limit'));
      });
      res.on('error', () => {
        process.exitCode = 1;
      });
      res.on('end', () => {
        if (res.statusCode === 409 && ['enter', 'recover'].includes(relayAction)) {
          console.log('{}');
          return;
        }
        if (res.statusCode !== 200) {
          process.exitCode = 1;
          return;
        }
        try {
          console.log(JSON.stringify(JSON.parse(bytes)));
        } catch {
          process.exitCode = 1;
        }
      });
    },
  );
  request.setTimeout(5000, () => request.destroy(Error('Local control timeout')));
  request.on('error', () => {
    process.exitCode = 1;
  });
  request.end();
}
