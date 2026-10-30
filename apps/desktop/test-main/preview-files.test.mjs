import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
const { createPreviewFiles, localWebsite } = createRequire(import.meta.url)(
  '../electron/preview-files.cjs',
);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-preview-'));
  const files = createPreviewFiles();
  t.after(async () => {
    await files.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'project/assets'), { recursive: true });
  await writeFile(
    join(root, 'project/index.html'),
    '<link rel="stylesheet" href="/assets/style.css"><script src="assets/app.js"></script>',
  );
  await writeFile(join(root, 'project/assets/style.css'), 'body{color:red}');
  await writeFile(join(root, 'project/assets/app.js'), 'document.title="local preview"');
  return { root, project: join(root, 'project'), files };
}
function resource(address, relative = '', host) {
  const url = new URL(relative || address, address);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: url.port,
        path: url.pathname,
        headers: { host: host ?? url.host },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString(),
            type: response.headers['content-type'],
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
test('HTML and relative/root assets stay on a private local origin, with separate roots and revocable URLs', async (t) => {
  const { files, project, root } = await fixture(t);
  const file = await files.read({ path: join(project, 'index.html'), root: project });
  assert.equal(file.kind, 'html');
  assert(files.owns(file.url));
  assert.equal((await resource(file.url)).status, 200);
  assert.equal((await resource(file.url, '/assets/style.css')).body, 'body{color:red}');
  assert.equal((await resource(file.url, 'assets/app.js')).type, 'text/javascript; charset=utf-8');
  await mkdir(join(project, '.local'));
  await writeFile(join(project, '.local/report.html'), '<h1>生成文件</h1>');
  await writeFile(join(project, '.local/theme.css'), 'h1{color:blue}');
  const generated = await files.read({ path: join(project, '.local/report.html'), root: project });
  assert.equal((await resource(generated.url)).status, 200);
  assert.equal((await resource(generated.url, 'theme.css')).body, 'h1{color:blue}');
  assert.equal((await files.target(generated.url)).path, join(project, '.local/report.html'));
  const other = join(root, 'other');
  await mkdir(other);
  await writeFile(join(other, 'index.html'), 'OTHER');
  const second = await files.read({ path: join(other, 'index.html') });
  assert.notEqual(new URL(file.url).origin, new URL(second.url).origin);
  assert.equal((await resource(second.url)).body, 'OTHER');
  assert.equal((await resource(file.url, '', 'attacker.invalid')).status, 404);
  files.release(file.token);
  assert(!files.owns(file.url));
  assert.equal((await resource(file.url)).status, 404);
  assert.equal((await resource(second.url)).status, 200);
  files.reset();
  assert.equal((await resource(second.url)).status, 404);
  assert.equal(files.owns(second.url), false);
});
test('preview resources reject hidden files, outside symlinks, encoded traversal and executable resources', async (t) => {
  const { files, project, root } = await fixture(t);
  await writeFile(join(project, '.env'), 'PRIVATE');
  await writeFile(join(project, 'run.exe'), 'EXECUTABLE');
  await writeFile(join(root, 'outside.txt'), 'OUTSIDE');
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside/secret.txt'), 'OUTSIDE');
  await symlink(join(root, 'outside'), join(project, 'link'), 'junction');
  await mkdir(join(project, '.claude'));
  await writeFile(join(project, '.claude/settings.json'), 'PRIVATE SETTINGS');
  await symlink(join(project, '.claude'), join(project, 'config-link'), 'junction');
  const file = await files.read({ path: join(project, 'index.html'), root: project });
  for (const name of [
    '/.env',
    '/run.exe',
    '/link/secret.txt',
    '/config-link/settings.json',
    '/%2e%2e/outside.txt',
    '/%2e%2e%5coutside.txt',
  ]) {
    const result = await resource(file.url, name);
    assert.notEqual(result.status, 200, name);
    assert(!result.body.includes('PRIVATE'));
    assert(!result.body.includes('OUTSIDE'));
  }
  assert.equal(await files.target(new URL('/link/secret.txt', file.url).href), null);
  assert.equal(await files.target(new URL('/config-link/settings.json', file.url).href), null);
  await assert.rejects(
    files.read({ path: join(root, 'outside/secret.txt'), root: project, restricted: true }),
    /工作区/,
  );
});
test('file preview handles Markdown and text without executing scripts, and rejects binary, oversized and shared paths', async (t) => {
  const { files, project } = await fixture(t);
  await writeFile(join(project, '说明.md'), '# 本机文档');
  await writeFile(join(project, 'script.ps1'), 'Write-Output hello');
  await writeFile(join(project, 'binary.dat'), Buffer.from([0, 1, 2]));
  await writeFile(join(project, 'large.txt'), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
  assert.equal((await files.read({ path: join(project, '说明.md') })).kind, 'markdown');
  assert.equal(
    (await files.read({ path: join(project, 'script.ps1') })).text,
    'Write-Output hello',
  );
  await assert.rejects(files.read({ path: join(project, 'binary.dat') }), /不支持/);
  await assert.rejects(files.read({ path: join(project, 'large.txt') }), /大小限制/);
  await assert.rejects(files.read({ path: '\\\\server\\share\\file.html' }), /本机/);
  await assert.rejects(files.read({ path: 'relative.txt' }), /绝对路径/);
});
test('website addresses allow only explicit local HTTP(S) services', () => {
  for (const value of ['http://localhost:5173', 'http://127.0.0.1:3000/a?b=1', 'http://[::1]:8080'])
    assert(localWebsite(value));
  for (const value of [
    'https://example.com',
    'file:///C:/a.html',
    'javascript:alert(1)',
    'http://localhost.evil.invalid',
    'http://user:password@localhost',
    'http://192.168.1.2',
  ])
    assert.throws(() => localWebsite(value));
});

test('resetting the renderer revokes an HTML read still in flight', async (t) => {
  const { files, project } = await fixture(t);
  const pending = files.read({ path: join(project, 'index.html'), root: project });
  files.reset();
  await assert.rejects(pending, /失效/);
  const reopened = await files.read({ path: join(project, 'index.html'), root: project });
  assert.equal((await resource(reopened.url)).status, 200);
});
