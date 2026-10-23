// Dedicated bounded IPC surface: the renderer cannot choose HTTP methods, paths, protocol, or artifacts.
function registerManagedServerUpdates(handle, getClient, openManager) {
  for (const action of ['check', 'install', 'status', 'cancel'])
    handle(`managed-server:${action}`, async (_event, ...args) => {
      if (args.length !== (action === 'cancel' ? 0 : 1))
        throw new Error('Invalid management arguments');
      return (await getClient())[action](...args);
    });
  handle('managed-server:manager', (_event, ...args) => {
    if (args.length) throw new Error('Invalid management arguments');
    return openManager('https://api.ghostapi.org/cc-updates/admin/updates');
  });
}
module.exports = { registerManagedServerUpdates };
