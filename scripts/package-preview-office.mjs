import { createRequire } from 'node:module';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Preserve complete engine resources and notices. These modules run in the main
// process, so bundling only the JS entry point would omit workers and native DLLs.
export function stagePreviewOffice(
  root,
  app,
  { platform = process.platform, arch = process.arch } = {},
) {
  const copied = new Set();
  function copy(name, from = createRequire(join(root, 'package.json'))) {
    if (copied.has(name)) return;
    let manifest;
    try {
      manifest = from.resolve(name + '/package.json');
    } catch {
      let directory = dirname(from.resolve(name));
      while (!existsSync(join(directory, 'package.json'))) {
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`Missing runtime package: ${name}`);
        directory = parent;
      }
      manifest = join(directory, 'package.json');
    }
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    if (metadata.name !== name) throw new Error(`Unexpected Office dependency: ${name}`);
    copied.add(name);
    const destination = join(app, 'node_modules', name);
    cpSync(dirname(manifest), destination, {
      recursive: true,
      filter: (file) =>
        !file.slice(dirname(manifest).length).split(/[\\/]/).includes('node_modules'),
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {}))
      copy(dependency, createRequire(manifest));
    delete metadata.scripts;
    delete metadata.optionalDependencies;
    writeFileSync(join(destination, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
    return metadata.version;
  }
  const versions = { '@deepseek-ai/libreoffice-kit': copy('@deepseek-ai/libreoffice-kit') };
  const native = ['win32', 'darwin'].includes(platform);
  const engine = native
    ? `@deepseek-ai/libreoffice-kit-${platform}-${arch}`
    : '@deepseek-ai/libreoffice-kit-wasm';
  versions[engine] = copy(engine);
  if (native) {
    versions.koffi = copy('koffi');
    const binding = `@koromix/koffi-${platform}-${arch}`;
    versions[binding] = copy(binding);
  }
  // electron-builder excludes extraneous node_modules even when a files glob names
  // them. The selected optional engine and binding are required production roots.
  return versions;
}
