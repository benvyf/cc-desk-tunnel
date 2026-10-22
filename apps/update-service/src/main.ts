import { readFile, stat } from 'node:fs/promises';
import { validateConfig } from './config.ts';
import { createUpdateServer } from './http.ts';
import { UpdateStore } from './store.ts';

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config')
    throw new Error('Expected --config FILE');
  if ((await stat(process.argv[3]!)).size > 65536) throw new Error('Configuration too large');
  const config = validateConfig(JSON.parse(await readFile(process.argv[3]!, 'utf8')));
  const store = await UpdateStore.open(config.dataDir, config.trustedKeys, config.adminName);
  const server = await createUpdateServer(store, config);
  server.once('error', async () => {
    console.error('Update service failed to listen.');
    await store.close();
    process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () =>
    console.log('Update service listening on loopback.'),
  );
  const shutdown = () => {
    server.close(() => {
      void store.close().catch(() => {
        process.exitCode = 1;
      });
    });
    const timer = setTimeout(() => process.exit(1), 15000);
    timer.unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  console.error(
    'Update service could not start; check Node 24, configuration, permissions and data-directory ownership.',
  );
  process.exitCode = 1;
}
