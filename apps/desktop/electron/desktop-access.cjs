const ORIGIN = 'https://api.ghostapi.org';

// The account session stays in the main process. Only short-lived connection tickets reach the renderer.
function createDesktopAccess({ request, read, write, storage, origin = ORIGIN }) {
  let session = null;
  let generation = 0;
  function persist(remember, autoLogin) {
    const saved =
      remember && storage.isEncryptionAvailable() && session
        ? {
            email: session.email,
            token: storage.encryptString(session.token).toString('base64'),
            autoLogin: !!autoLogin,
          }
        : null;
    write(saved);
  }
  async function api(path, data, token) {
    let response;
    try {
      response = await request(origin + '/cc-access/v1/' + path, {
        method: data === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    } catch {
      throw Object.assign(new Error('无法连接 CC 管理中心，请检查网络后重试。'), {
        retryable: true,
      });
    }
    const value = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok)
      throw Object.assign(new Error(value?.error || '管理中心暂不可用，请稍后重试。'), {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    if (response.status !== 204 && !value) throw new Error('管理中心返回了无效信息，请稍后重试。');
    return value;
  }
  function clearExpired(error, current) {
    if (error.status === 401 && session === current) {
      generation++;
      session = null;
      write(null);
    }
    throw error;
  }
  return {
    load() {
      const saved = read();
      try {
        if (saved?.token && storage.isEncryptionAvailable()) {
          session = {
            email: saved.email,
            token: storage.decryptString(Buffer.from(saved.token, 'base64')),
          };
          return { email: session.email, remember: true, autoLogin: !!saved.autoLogin };
        }
      } catch {
        write(null);
      }
      return null;
    },
    async login(input) {
      if (
        !input ||
        typeof input.email !== 'string' ||
        typeof input.password !== 'string' ||
        input.email.length > 254 ||
        input.password.length > 128
      )
        throw new Error('请输入邮箱和密码。');
      const turn = ++generation;
      const email = input.email.trim().toLowerCase();
      let next;
      if (!input.password && session?.email === email) {
        const current = session;
        const value = await api('workspaces', undefined, current.token).catch((error) =>
          clearExpired(error, current),
        );
        next = { ...current, workspaces: value.workspaces };
      } else {
        next = await api('login', { email, password: input.password, remember: !!input.remember });
      }
      if (turn !== generation) throw new Error('登录已取消。');
      if (!next || typeof next.token !== 'string' || !Array.isArray(next.workspaces))
        throw new Error('管理中心返回了无效登录信息。');
      session = { email: next.email, token: next.token };
      persist(!!input.remember, !!input.autoLogin);
      return { email: next.email, workspaces: next.workspaces };
    },
    async ticket(nodeId) {
      if (!session || typeof nodeId !== 'string') throw new Error('请先登录邮箱账号。');
      const turn = generation,
        current = session;
      const value = await api('connect', { nodeId }, current.token).catch((error) =>
        clearExpired(error, current),
      );
      if (turn !== generation || current !== session) throw new Error('登录已取消。');
      const url = new URL(value.url);
      if (
        url.protocol !== 'wss:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        typeof value.token !== 'string' ||
        !/^ccs_[A-Za-z0-9_-]{43}$/.test(value.token) ||
        typeof value.fingerprint !== 'string'
      )
        throw new Error('工作空间连接配置无效，请联系管理员。');
      return { url: url.href, fingerprint: value.fingerprint, token: value.token };
    },
    async logout() {
      generation++;
      const previous = session;
      session = null;
      write(null);
      if (previous) await api('logout', {}, previous.token);
    },
  };
}
module.exports = { createDesktopAccess, ORIGIN };
