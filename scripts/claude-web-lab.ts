// Disposable synthetic lab. Never import main.ts, read production settings or launch a native agent.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from '../apps/server/src/server.ts';
import { offlineFramebuffer } from '../apps/desktop/test/fixtures/offline-rfb.ts';

export async function startBrowserLab(options: {
  directory: string;
  token: string;
  endpoint: string;
  cert: Buffer;
  key: Buffer;
  host: string;
  port: number;
}) {
  const service = createProxyServer({
    token: options.token,
    dataDir: options.directory,
    browserEndpoint: options.endpoint,
    host: options.host,
    tls: { cert: options.cert, key: options.key },
  });
  try {
    return { address: await service.listen(options.port), close: () => service.close() };
  } catch (error) {
    // Failed startup closes its store and timers too.
    await service.close().catch(() => {});
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['fixture', 'service'].includes(mode)) throw new Error('Use fixture or service mode');
  const lab =
    mode === 'fixture'
      ? await offlineFramebuffer({ host: '0.0.0.0', port: 6080 })
      : await startBrowserLab({
          directory: '/tmp/cc-browser-lab-data',
          token: readFileSync('/run/cc-browser-lab/token', 'utf8').trim(),
          cert: readFileSync('/run/cc-browser-lab/cert.pem'),
          key: readFileSync('/run/cc-browser-lab/key.pem'),
          endpoint: 'ws://cc-claude-web:6080/',
          host: '0.0.0.0',
          port: 8787,
        });
  console.log(`CC_BROWSER_LAB_READY ${mode}; synthetic only; expires in 45 minutes`);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(expiry);
    await lab.close();
  };
  const expiry = setTimeout(() => void stop(), 45 * 60 * 1000);
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}
