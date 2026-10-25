import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// This harness runs only the installed builder's directory-page callback, never an installer.
const compiler = process.env.NSIS_BRANDING_COMPILER;
test(
  'the real NSIS directory-page callback preserves old install paths and the new executable name',
  {
    skip:
      process.platform !== 'win32' || !compiler
        ? 'Set NSIS_BRANDING_COMPILER to the cached makensis.exe.'
        : false,
  },
  (t) => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), 'cc-space-nsis-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const template = join(root, 'node_modules/app-builder-lib/templates/nsis');
    const callback = readFileSync(join(template, 'assistedInstaller.nsh'), 'utf8').match(
      /Function instFilesPre[\s\S]*?FunctionEnd/,
    )[0];
    const hook = join(root, 'scripts/installer-branding.nsh');
    const program = join(directory, 'directory-check.exe');
    const report = join(directory, 'result.txt');
    const source = join(directory, 'check.nsi');
    writeFileSync(
      source,
      `
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${program}"
!include "LogicLib.nsh"
!include "${join(template, 'include/StrContains.nsh')}"
!define APP_FILENAME "CC SPACE"
!define PRODUCT_FILENAME "CC SPACE"
${existsSync(hook) ? `!include "${hook}"` : ''}
${callback}
Section
  FileOpen $1 "${report}" w
  FileWrite $1 "${'${PRODUCT_FILENAME}'}$\\r$\\n"
  StrCpy $INSTDIR "C:\\existing\\CC Desk Tunnel"
  Call instFilesPre
  FileWrite $1 "$INSTDIR$\\r$\\n"
  StrCpy $INSTDIR "D:\\custom path\\CC Desk Tunnel"
  Call instFilesPre
  FileWrite $1 "$INSTDIR$\\r$\\n"
  StrCpy $INSTDIR "C:\\new location"
  Call instFilesPre
  FileWrite $1 "$INSTDIR$\\r$\\n"
  FileClose $1
SectionEnd
`,
    );
    execFileSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V2', source], {
      windowsHide: true,
      stdio: 'pipe',
    });
    execFileSync(program, [], { windowsHide: true, timeout: 15000 });
    assert.deepEqual(readFileSync(report, 'utf8').trim().split(/\r?\n/), [
      'CC SPACE',
      'C:\\existing\\CC Desk Tunnel',
      'D:\\custom path\\CC Desk Tunnel',
      'C:\\new location\\CC Desk Tunnel',
    ]);
  },
);
