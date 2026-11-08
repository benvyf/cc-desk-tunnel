import { builtinModules, createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'vite';

// Called after the CommonJS source files are staged. The standalone bundle
// replaces their development shim without copying an SDK dependency tree.
export async function bundleDifferentialEngine(root, appDirectory) {
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  if (require('electron-updater/package.json').version !== '6.8.10')
    throw new Error('Unsupported differential engine version');
  await build({
    configFile: false,
    root,
    ssr: { noExternal: true },
    build: {
      ssr: true,
      target: 'node24',
      outDir: join(appDirectory, 'electron'),
      emptyOutDir: false,
      license: { fileName: 'managed-differential-engine.LICENSE.md' },
      rolldownOptions: {
        input: join(root, 'apps/desktop/electron/managed-differential-engine.mjs'),
        external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
        output: {
          format: 'cjs',
          entryFileNames: 'managed-differential-engine.cjs',
          codeSplitting: false,
        },
      },
    },
  });
}
