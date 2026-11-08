const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const encoded = (value) => Buffer.from(value, 'utf16le').toString('base64');

exports.launchInstaller = async (helper, input) => {
  // Windows PowerShell 5.1 can exit without running its script under DETACHED_PROCESS.
  // Start-Process creates an independent hidden console that survives the client exiting.
  const externalHelper = path.join(path.dirname(input.pending), 'managed-install.ps1');
  fs.copyFileSync(helper, externalHelper);
  const powershell = path.join(
    process.env.SystemRoot,
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const command = `& ${literal(externalHelper)} -Installer ${literal(input.file)} -InstallDirectory ${literal(input.directory)} -ExpectedHash ${literal(input.release.sha256)} -ExpectedSize ${input.release.size} -ParentPid ${input.parentPid} -Pending ${literal(input.pending)}`;
  const pidFile = `${input.pending}.helper-pid.txt`;
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=Start-Process -FilePath ${literal(powershell)} -WindowStyle Hidden -ArgumentList '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded(command)}' -RedirectStandardOutput ${literal(`${input.pending}.helper-stdout.txt`)} -RedirectStandardError ${literal(`${input.pending}.helper-stderr.txt`)} -PassThru; [IO.File]::WriteAllText(${literal(pidFile)}, [string]$p.Id)`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)],
      {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10000,
        env: {
          ...process.env,
          PSModulePath: path.join(
            process.env.SystemRoot,
            'System32/WindowsPowerShell/v1.0/Modules',
          ),
        },
      },
    );
    child.once('error', reject);
    // A hidden console may retain inherited handles; wait for process exit, not pipe closure.
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`安装助手启动失败：${code}`)),
    );
  });
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  fs.unlinkSync(pidFile);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('无法启动安装助手');
  return pid;
};
