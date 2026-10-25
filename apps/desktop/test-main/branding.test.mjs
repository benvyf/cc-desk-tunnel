import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
for (const [packaged, override] of [
  [true, false],
  [true, true],
  [false, false],
]) {
  test(`brand identity preserves profile data (packaged=${packaged}, override=${override})`, (t) => {
    const { configureBrand } = require('../electron/branding.cjs');
    const fixture = mkdtempSync(join(tmpdir(), 'cc-space-brand-'));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const paths = {
      appData: join(fixture, 'app-data'),
      userData: join(fixture, 'chosen-profile'),
    };
    const app = {
      isPackaged: packaged,
      commandLine: { hasSwitch: (key) => key === 'user-data-dir' && override },
      getPath: (key) => paths[key],
      setPath: (key, value) => {
        assert.ok(existsSync(value), 'Electron requires the selected profile directory to exist');
        paths[key] = value;
      },
      setName: (value) => {
        app.name = value;
      },
    };
    const expected = packaged && !override ? join(paths.appData, 'CC Desk Tunnel') : paths.userData;
    assert.equal(configureBrand(app, 'win32'), expected);
    assert.equal(paths.userData, expected);
    assert.equal(paths.sessionData, expected);
    assert.equal(app.name, 'CC SPACE');
    const { appId } = require('../brand.json');
    assert.equal(appId, 'io.github.ccdesktunnel.desktop');
  });
}

for (const platform of ['linux', 'darwin']) {
  for (const [packaged, originalName, credentialName, override] of [
    [true, 'CC SPACE', 'CC Desk Tunnel', false],
    [true, 'CC SPACE', 'CC Desk Tunnel', true],
    [true, 'CC Managed Update Acceptance', 'CC Managed Update Acceptance', true],
    [false, '@cc-desk-tunnel/desktop', '@cc-desk-tunnel/desktop', false],
  ]) {
    test(`${platform} retains the ${originalName} credential identity before ready (override=${override})`, (t) => {
      const { configureBrand } = require('../electron/branding.cjs');
      const fixture = mkdtempSync(join(tmpdir(), 'cc-space-keychain-'));
      t.after(() => rmSync(fixture, { recursive: true, force: true }));
      const legacy = join(fixture, 'CC Desk Tunnel');
      mkdirSync(legacy);
      writeFileSync(join(legacy, 'settings.json'), '{"remember":true}');
      const app = Object.assign(new EventEmitter(), {
        isPackaged: packaged,
        name: originalName,
        commandLine: { hasSwitch: () => override },
        getName: () => app.name,
        getPath: (key) => (key === 'appData' ? fixture : legacy),
        setPath: (_key, value) => assert.ok(existsSync(value)),
        setName: (name) => {
          app.name = name;
        },
      });
      configureBrand(app, platform);
      // Electron captures the OS crypt/keychain identity before emitting ready.
      assert.equal(app.name, credentialName);
      app.emit('ready');
      assert.equal(app.name, 'CC SPACE');
      assert.equal(readFileSync(join(legacy, 'settings.json'), 'utf8'), '{"remember":true}');
    });
  }
}
