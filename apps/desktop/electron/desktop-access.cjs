const ORIGIN = 'https://api.ghostapi.org';

// The account session stays in the main process. Only short-lived connection tickets reach the renderer.
function createDesktopAccess({
  request,
  read,
  write,
  storage,
  deviceId,
  onExpired,
  origin = ORIGIN,
}) {
  let session = null;
  let generation = 0;
  let checking = false;
  let signingIn = 0;
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
  async function api(path, data, token, signal, timeout = 10_000) {
    let response;
    try {
      response = await request(origin + '/cc-access/v1/' + path, {
        method: data === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
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
    if (response.status !== 204 && !value)
      throw Object.assign(new Error('管理中心返回了无效信息，请稍后重试。'), { retryable: true });
    return value;
  }
  function clearExpired(error, current, turn) {
    if (error.status === 401 && session === current && generation === turn) {
      generation++;
      session = null;
      write(null);
      onExpired?.(error.message);
    }
  }
  return {
    async serverRequest(nodeId, route, body, signal) {
      if (!session || typeof nodeId !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(nodeId))
        throw new Error('请先登录邮箱并选择工作空间。');
      const action = /^\/cc-managed\/server\/v1\/(check|install|status)$/.exec(route)?.[1];
      if (!action) throw new Error('无效服务端升级操作。');
      const current = session,
        turn = generation;
      const result = await api(
        `server/${action}`,
        { ...body, nodeId },
        current.token,
        signal,
        action === 'install' ? 180_000 : 50_000,
      ).catch((error) => {
        clearExpired(error, current, turn);
        if (error.status === 404)
          throw new Error('管理中心尚未启用邮箱远端升级，请先更新管理中心。');
        if (error.retryable) throw new Error('服务管理网络请求失败；请稍候查询升级状态。');
        throw error;
      });
      if (current !== session || turn !== generation) throw new Error('登录已失效，请重新登录。');
      return result;
    },
    load() {
      const saved = read();
      try {
        if (saved?.token && storage.isEncryptionAvailable()) {
          session = {
            email: saved.email,
            token: storage.decryptString(Buffer.from(saved.token, 'base64')),
            remembered: true,
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
      const remember = !!input.remember || !!input.autoLogin;
      signingIn++;
      try {
        const email = input.email.trim().toLowerCase();
        let next;
        if (!input.password && session?.email === email) {
          const current = session;
          if (remember && !current.remembered)
            throw new Error('启用记住登录或自动登录，请输入一次密码。');
          const value = await api('workspaces', undefined, current.token).catch((error) => {
            clearExpired(error, current, turn);
            throw error;
          });
          next = { ...current, workspaces: value.workspaces };
        } else {
          next = await api('login', {
            email,
            password: input.password,
            remember,
            ...(deviceId ? { deviceId: deviceId() } : {}),
          });
        }
        if (turn !== generation) throw new Error('登录已取消。');
        if (!next || typeof next.token !== 'string' || !Array.isArray(next.workspaces))
          throw new Error('管理中心返回了无效登录信息。');
        session = { email: next.email, token: next.token, remembered: next.remembered ?? remember };
        persist(remember, !!input.autoLogin);
        return { email: next.email, workspaces: next.workspaces };
      } finally {
        signingIn--;
      }
    },
    async ticket(nodeId) {
      if (!session || typeof nodeId !== 'string') throw new Error('请先登录邮箱账号。');
      const turn = generation,
        current = session;
      const value = await api('connect', { nodeId }, current.token).catch((error) => {
        clearExpired(error, current, turn);
        throw error;
      });
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
    async check() {
      if (!session || checking || signingIn) return;
      checking = true;
      const current = session,
        turn = generation;
      try {
        await api('workspaces', undefined, current.token);
      } catch (error) {
        // A temporary network failure does not sign the user out.
        clearExpired(error, current, turn);
      } finally {
        checking = false;
      }
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
