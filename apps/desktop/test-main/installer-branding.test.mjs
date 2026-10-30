import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// This harness exercises directory selection in a temporary program, never the application installer.
const compiler = process.env.NSIS_BRANDING_COMPILER;
test(
  'NSIS uses CC SPACE for fresh installs and preserves legacy and registered custom install paths',
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
    const perUser = readFileSync(join(template, 'multiUser.nsh'), 'utf8').match(
      /!macro setInstallModePerUser[\s\S]*?!macroend/,
    )[0];
    const registryKey = `Software\\CCSpaceInstallerTest\\${basename(directory)}`;
    t.after(() => {
      try {
        execFileSync('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {}
    });
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
!include "FileFunc.nsh"
!include "${join(template, 'include/StrContains.nsh')}"
!define APP_FILENAME "CC SPACE"
!define PRODUCT_FILENAME "CC SPACE"
!define SHELL_CONTEXT HKCU
!define INSTALL_REGISTRY_KEY "${registryKey}"
!define FOLDERID_UserProgramFiles {5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}
!define KF_FLAG_CREATE 0x00008000
Var installMode
Var perUserInstallationFolder
; No command-line directory override in this harness.
!macro GetDParameter outVar
  StrCpy ${'${outVar}'} ""
!macroend
${existsSync(hook) ? `!include "${hook}"` : ''}
${perUser}
${callback}
!define MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre
!ifmacrodef customPageAfterChangeDir
  !insertmacro customPageAfterChangeDir
!endif
Section
  FileOpen $1 "${report}" w
  FileWrite $1 "${'${PRODUCT_FILENAME}'}$\\r$\\n"
  FileWrite $1 "${'${APP_FILENAME}'}$\\r$\\n"
  !insertmacro setInstallModePerUser
  Call ${'${MUI_PAGE_CUSTOMFUNCTION_PRE}'}
  FileWrite $1 "$INSTDIR$\\r$\\n"
  StrCpy $INSTDIR "C:\\existing\\CC Desk Tunnel"
  Call ${'${MUI_PAGE_CUSTOMFUNCTION_PRE}'}
  FileWrite $1 "$INSTDIR$\\r$\\n"
  StrCpy $INSTDIR "D:\\custom path\\CC Desk Tunnel"
  Call ${'${MUI_PAGE_CUSTOMFUNCTION_PRE}'}
  FileWrite $1 "$INSTDIR$\\r$\\n"
  StrCpy $INSTDIR "C:\\new location"
  Call ${'${MUI_PAGE_CUSTOMFUNCTION_PRE}'}
  FileWrite $1 "$INSTDIR$\\r$\\n"
  StrCpy $INSTDIR "C:\\new location\\CC SPACE"
  Call ${'${MUI_PAGE_CUSTOMFUNCTION_PRE}'}
  FileWrite $1 "$INSTDIR$\\r$\\n"
  StrCpy $INSTDIR "C:\\new location\\CC SPACE\\"
  Call ${'${MUI_PAGE_CUSTOMFUNCTION_PRE}'}
  FileWrite $1 "$INSTDIR$\\r$\\n"
  WriteRegStr HKCU "${registryKey}" InstallLocation "D:\\custom path\\Agent"
  !insertmacro setInstallModePerUser
  Call ${'${MUI_PAGE_CUSTOMFUNCTION_PRE}'}
  FileWrite $1 "$INSTDIR$\\r$\\n"
  DeleteRegKey HKCU "${registryKey}"
  FileClose $1
SectionEnd
`,
    );
    execFileSync(compiler, ['/WX', '/INPUTCHARSET', 'UTF8', '/V2', source], {
      windowsHide: true,
      stdio: 'pipe',
    });
    execFileSync(program, [], { windowsHide: true, timeout: 15000 });
    const actual = readFileSync(report, 'utf8').trim().split(/\r?\n/);
    assert.match(actual[2], /\\CC SPACE$/);
    assert.deepEqual(
      [...actual.slice(0, 2), ...actual.slice(3)],
      [
        'CC SPACE',
        'CC SPACE',
        'C:\\existing\\CC Desk Tunnel',
        'D:\\custom path\\CC Desk Tunnel',
        'C:\\new location\\CC SPACE',
        'C:\\new location\\CC SPACE',
        'C:\\new location\\CC SPACE',
        'D:\\custom path\\Agent',
      ],
    );
  },
);
