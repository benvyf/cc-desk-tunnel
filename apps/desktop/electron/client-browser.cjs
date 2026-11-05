// Management stays in the administrator's browser, outside the client UI and its link handlers.
function openClientBrowser(target, openExternal) {
  const url = new URL(String(target));
  const pathname = new URL(
    decodeURIComponent(url.pathname).replaceAll('\\', '/').replace(/\/+/g, '/'),
    'https://client.invalid',
  ).pathname;
  if (
    url.hostname.replace(/\.$/, '').toLowerCase() === 'api.ghostapi.org' &&
    /^\/cc-updates\/admin(?:\/|$)/i.test(pathname)
  )
    throw new Error('管理中心仅供管理员在浏览器中访问。');
  return openExternal(url.href);
}

module.exports = { openClientBrowser };
