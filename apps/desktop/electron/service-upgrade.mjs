// Keep the bridge export for existing callers, but never open an upgrade connection.
export async function upgradeService() {
  throw new Error('定制版服务端由管理员统一部署，请联系管理员。');
}
