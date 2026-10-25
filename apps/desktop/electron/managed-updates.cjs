// Custom builds are distributed by the administrator, never by a renderer request.
exports.registerManagedUpdates = (handle) => {
  for (const channel of ['service:upgrade', 'update:install', 'release:notes'])
    handle(channel, () => {
      throw new Error('定制版更新由管理员统一部署，请联系管理员。');
    });
};

exports.registerClientUpdates = (handle, runtime) => {
  for (const action of ['state', 'check', 'download', 'install', 'cancel'])
    handle(`managed-update:${action}`, (_event, ...args) => {
      if (args.length) throw new Error('更新操作不接受 URL、路径或版本参数');
      return runtime[action]();
    });
  handle('managed-update:activity', (_event, activity) => runtime.report(activity));
};

exports.createManagedRuntime = ({ app, notify, quit, log, isBusy = () => false }) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  let controller;
  let disabled = { phase: 'disabled', message: '此构建未启用定制在线更新。' };
  const runtime = {
    state: () => (controller ? controller.state() : disabled),
    report: (activity) => controller?.report({ blocked: activity?.blocked !== false || isBusy() }),
    frozen: () => ['preparing', 'installing'].includes(runtime.state().phase),
    stop: () => controller?.stop(),
    initialize: async () => {
      if (!app.isPackaged || process.platform !== 'win32' || process.arch !== 'x64') return;
      const file = path.resolve(__dirname, 'managed-build.json');
      if (!fs.existsSync(file)) return;
      try {
        const { ManagedController } = require('./managed-controller.cjs');
        const { createNetwork } = require('./managed-network.cjs');
        const { createManagedFetch } = require('./managed-fetch.cjs');
        const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (identity.appVersion !== app.getVersion()) throw new Error('内嵌版本与程序不符');
        const pwsh = path.join(process.resourcesPath, 'vendor/pwsh/pwsh.exe');
        const helper = path.resolve(
          process.resourcesPath,
          'app.asar.unpacked/electron/managed-install.ps1',
        );
        const executable = fs.realpathSync(process.execPath);
        const installDirectory = path.dirname(executable);
        const processes = async () => {
          const script = `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetDirectoryName($_.ExecutablePath).Equals('${installDirectory.replaceAll("'", "''")}', [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { [int]$_.ProcessId })`;
          const { stdout } = await promisify(execFile)(
            pwsh,
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(script, 'utf16le').toString('base64'),
            ],
            { windowsHide: true, timeout: 10000 },
          );
          const pids = JSON.parse(stdout.trim());
          if (!Array.isArray(pids) || !pids.includes(process.pid))
            throw new Error('无法确认所有客户端进程');
          return pids;
        };
        const candidate = new ManagedController({
          identity,
          executable,
          localAppData: process.env.LOCALAPPDATA,
          contract: require('./managed-contract.cjs'),
          network: createNetwork(
            createManagedFetch({ app, origin: identity.origin }),
            identity.origin,
          ),
          notify,
          quit,
          processes,
          launchInstaller: (input) =>
            require('./managed-launch.cjs').launchInstaller(helper, input),
        });
        controller = candidate;
        try {
          await candidate.recover();
        } catch (error) {
          if (error.code !== 'EADDRINUSE') throw error;
        }
        candidate.start((error) => {
          disabled = { phase: 'disabled', message: `定制更新状态读取失败：${error.message}` };
          controller = null;
          log(`Managed update state failed: ${error.stack ?? error.message}`);
          notify(disabled);
        }, !process.argv.includes('--smoke-test'));
        notify(candidate.state());
      } catch (error) {
        controller?.stop();
        controller = null;
        disabled = { phase: 'disabled', message: `定制更新不可用：${error.message}` };
        log(`Managed updates unavailable: ${error.stack ?? error.message}`);
        notify(disabled);
        if (error.code === 'UPDATE_INSTALL_ACTIVE') quit();
      }
    },
  };
  for (const action of ['check', 'download', 'install', 'cancel'])
    runtime[action] = () => {
      if (!controller) throw new Error(disabled.message);
      return controller[action]();
    };
  return runtime;
};
