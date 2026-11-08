import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
test(
  'retired deployment commands reject before loading configuration or reading files',
  { skip: !existsSync(bash) },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-managed-command-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const command of ['client', 'release-token']) {
      const result = spawnSync(
        bash,
        [
          fileURLToPath(new URL('../../../deploy/manage.sh', import.meta.url)),
          command,
          join(directory, 'must-not-read'),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PROXY_DEPLOY_CONFIG: join(directory, 'missing.env') },
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Online updates are disabled/);
      assert.equal(existsSync(join(directory, 'missing.env')), false);
    }
  },
);
test(
  'the managed image ignores a previously downloaded newer program without deleting it',
  { skip: !existsSync(bash) },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-managed-entrypoint-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const posix = (path) =>
      path.replaceAll('\\', '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`);
    const root = posix(directory);
    for (const rel of [
      'bin',
      'app',
      'data/config',
      'data/home',
      'data/state',
      'data/program/99.0.0/apps/server/src',
    ])
      mkdirSync(join(directory, rel), { recursive: true });
    writeFileSync(join(directory, 'data/config/service.env'), '');
    writeFileSync(join(directory, 'data/program/current'), '99.0.0\n');
    writeFileSync(join(directory, 'data/program/attempts'), '0\n');
    writeFileSync(
      join(directory, 'data/program/99.0.0/apps/server/src/main.ts'),
      'throw new Error("old update must not run");',
    );
    writeFileSync(
      join(directory, 'bin/node'),
      '#!/usr/bin/env bash\nif [[ "$1" = -p ]]; then echo 0.3.6; else printf "EXECUTED:%s\\n" "$*"; fi\n',
      { mode: 0o755 },
    );
    const entrypoint = readFileSync(
      new URL('../../../deploy/docker/entrypoint.sh', import.meta.url),
      'utf8',
    ).replace(/\/(data|app)(?=\/|["\n])/g, (_, name) => `${root}/${name}`);
    writeFileSync(join(directory, 'entrypoint.sh'), entrypoint);
    const stdout = execFileSync(
      bash,
      ['-c', `export PATH='${root}/bin':"$PATH"; bash '${root}/entrypoint.sh' server`],
      { encoding: 'utf8' },
    );
    assert.ok(stdout.includes(`${root}/app/apps/server/src/managed-main.ts`), stdout);
    assert.equal(stdout.includes(`${root}/data/program/99.0.0/apps/server/src/main.ts`), false);
    assert.equal(readFileSync(join(directory, 'data/program/attempts'), 'utf8'), '0\n');
    assert.equal(readFileSync(join(directory, 'data/program/current'), 'utf8'), '99.0.0\n');
  },
);
