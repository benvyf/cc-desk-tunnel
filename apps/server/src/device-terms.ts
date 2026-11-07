import type { DevicePlatform, DeviceShell } from '@cc-desk-tunnel/protocol';

export const DEVICE_TERMS_REVISION = 2;
export type DeviceExecution = { shells: DeviceShell[]; shell?: DeviceShell };
export const systemShell = (platform: DevicePlatform): DeviceShell =>
  platform === 'win32' ? 'pwsh' : platform === 'darwin' ? 'zsh' : 'bash';

// What Claude is told that depends on the system of the device: in the system prompt, and again with a
// message when a session goes on from a device of another system. Everything else reads the same for all,
// and is worded to hold on every system: what becomes of a process when its command ends differs between
// them, so Claude is told to count on neither outcome.
export function deviceTerms(
  platform: DevicePlatform,
  projectPath: string,
  viaSsh = false,
  execution?: DeviceExecution,
) {
  if (platform === 'win32') {
    const remote = projectPath.replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/');
    return {
      name: 'Windows',
      script:
        `On Windows it is PowerShell 7, as plain text: any length, UTF-8, nothing to escape or encode. Errors come back as plain text and the script's exit code is kept; standard input is the script, so it cannot read more. Begin it with Set-Location -LiteralPath '${projectPath.replaceAll("'", "''")}'.` +
        (execution
          ? ` Use device-pwsh for PowerShell scripts; device-script remains the same PowerShell compatibility alias.` +
            (execution.shells.includes('bash')
              ? ` Git Bash is also available as device-bash: send a Bash here-document on stdin and begin with cd '${projectPath
                  .replaceAll('\\', '/')
                  .replace(/^([A-Za-z]):/, (_, drive: string) => '/' + drive.toLowerCase())
                  .replaceAll(
                    "'",
                    "'\\''",
                  )}'. Git Bash is still Windows: no apt; ps, kill and /proc see only its own processes. Use PowerShell for other Windows processes. MSYS converts Unix-looking arguments for Windows programs; use //c for cmd.exe's /c switch.`
              : ' Git Bash is unavailable; do not use device-bash.') +
            ` The preferred shell is ${execution.shell === 'bash' && execution.shells.includes('bash') ? 'Git Bash' : 'PowerShell 7'}; the other available shell may be used when better suited.`
          : ''),
      command: remote.startsWith('//')
        ? `The host device runs a command line as it is, parsed by cmd.exe on Windows. The project uses a UNC or extended Windows path ${JSON.stringify(projectPath)}; its scp/sftp representation is unverified. Do not invent a drive mapping; use the device shell for project file operations.`
        : `The host device runs a command line as it is, parsed by cmd.exe on Windows, and is the one for scp or sftp, where an absolute drive path takes forward slashes and a slash before its drive: the project directory is ${JSON.stringify(`device:${remote}`)}.`,
    };
  }
  const name = platform === 'darwin' ? 'macOS' : 'Linux';
  return {
    name,
    script:
      `On ${name} it is ${viaSsh ? 'Bash with the non-interactive SSH environment of the target' : "the user's own shell, zsh or bash, with the environment of their terminal"}, as plain text: any length, UTF-8, nothing to escape or encode. The script's exit code is kept; standard input is the script, so it cannot read more. Begin it with cd -- '${projectPath.replaceAll("'", "'\\''")}'.` +
      (execution
        ? ` Use ${execution.shells.map((shell) => `device-${shell}`).join(' or ')} for scripts; device-script keeps its original shell semantics.`
        : ''),
    command: `The host device runs a command line as it is, parsed by that same shell, and is the one for scp or sftp: the project directory is ${JSON.stringify(`device:${projectPath}`)}.`,
  };
}
