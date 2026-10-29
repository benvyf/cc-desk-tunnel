import { serviceJson } from '../../desktop/electron/secure-service.mjs';
import { DesktopAccess } from './desktop-access.ts';
import { UpdateError } from './store.ts';

// No URL, credential, HTTP method or remote route is selected by the caller.
export async function desktopServerUpdate(
  access: DesktopAccess,
  session: string,
  action: string,
  input: Record<string, unknown>,
) {
  const fields =
    action === 'status'
      ? ['nodeId']
      : action === 'check'
        ? ['nodeId', 'clientProtocol']
        : action === 'install'
          ? ['nodeId', 'clientProtocol', 'confirmed', 'build', 'sha256']
          : [];
  if (
    !fields.length ||
    Object.keys(input).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(input, key)) ||
    typeof input.nodeId !== 'string' ||
    !/^[a-z0-9_-]{1,80}$/.test(input.nodeId)
  )
    throw new UpdateError(400, '无效服务端升级请求。');
  if (
    action !== 'status' &&
    (!Number.isSafeInteger(input.clientProtocol) || Number(input.clientProtocol) <= 0)
  )
    throw new UpdateError(400, '无效客户端协议。');
  if (
    action === 'install' &&
    (input.confirmed !== true ||
      !Number.isSafeInteger(input.build) ||
      Number(input.build) <= 0 ||
      typeof input.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.sha256))
  )
    throw new UpdateError(400, '请确认具体升级版本。');
  const connection = access.serverConnection(session, input.nodeId);
  const { nodeId: _, ...body } = input;
  try {
    return await serviceJson(
      connection,
      action === 'status' ? 'GET' : 'POST',
      `/cc-managed/server/v1/${action}`,
      action === 'status' ? undefined : body,
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404)
      throw new UpdateError(409, '远端尚未接入受控升级，请在管理中心完成首次接入。');
    if (status === 401)
      throw new UpdateError(409, '服务端暂不支持当前登录方式更新，请先升级服务端。');
    if (status === 409) throw new UpdateError(409, '服务繁忙或升级目标已变化，请重新检查后确认。');
    throw new UpdateError(502, '服务管理网络请求失败；服务重启期间请稍候查询状态。');
  } finally {
    access.releaseServerConnection(connection.token);
  }
}
