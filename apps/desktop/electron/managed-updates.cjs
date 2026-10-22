// Custom builds are distributed by the administrator, never by a renderer request.
exports.registerManagedUpdates = (handle) => {
  for (const channel of ['service:upgrade', 'update:install', 'release:notes'])
    handle(channel, () => {
      throw new Error('定制版更新由管理员统一部署，请联系管理员。');
    });
};
