import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import {
  verifyServerIndex,
  strictObject,
  requireValue,
} from '../../../packages/managed-server/src/index.ts';
import identity from '../../../deploy/managed-server.json' with { type: 'json' };
import { controlTlsOptions, serviceJson } from './secure-service.mjs';

const fields = ['url', 'fingerprint', 'token'];
const phases = [
  'idle',
  'staging',
  'stopping',
  'backup',
  'switching',
  'probing',
  'committed',
  'rolled-back',
  'failed',
];
const reasons = [
  'available',
  'current',
  'protocol-unavailable',
  'manual-image-upgrade',
  'disabled',
  'busy',
];
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const digest = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function connection(input, install = false) {
  strictObject(input, install ? [...fields, 'confirmed', 'build', 'sha256'] : fields);
  requireValue(
    typeof input.url === 'string' &&
      input.url.length <= 2048 &&
      typeof input.fingerprint === 'string' &&
      input.fingerprint.length <= 95 &&
      typeof input.token === 'string' &&
      input.token.length >= 24 &&
      input.token.length <= 4096 &&
      !/[\r\n\x00]/.test(input.token),
    '无效服务管理参数。',
  );
  const url = new URL(input.url);
  requireValue(
    url.protocol === 'wss:' && !url.username && !url.password && !url.search && !url.hash,
    '服务管理需要不含凭据、查询或片段的 WSS 地址。',
  );
  controlTlsOptions(input);
  if (install)
    requireValue(
      input.confirmed === true && positive(input.build) && digest(input.sha256),
      '需要确认精确构建与摘要。',
    );
  return Object.fromEntries(fields.map((f) => [f, input[f]]));
}
function currentProgram(value) {
  strictObject(value, ['build', 'protocol', 'appVersion', 'sha256']);
  requireValue(
    positive(value.build) &&
      positive(value.protocol) &&
      typeof value.appVersion === 'string' &&
      /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.]{1,40})?$/.test(value.appVersion) &&
      (value.sha256 === null || digest(value.sha256)),
    '无效服务端状态。',
  );
}
const binding = (config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');

// The renderer can name only connection credentials and the exact displayed build/hash. Protocol, trust,
// methods, routes, signature verification and the confirmation cache belong to this main-process client.
export function createManagedServerClient({
  keys = identity.keys,
  request = serviceJson,
  resolveProxy,
  isBlocked = () => false,
  now = Date.now,
  readReplay = () => undefined,
  writeReplay = () => {},
} = {}) {
  let replay = readReplay(),
    confirmation,
    tracking,
    operation,
    generation = 0;
  let activeUntil = 0;
  const busy = () => !!operation || now() < activeUntil;
  const idle = () => requireValue(!isBlocked(), '请先让客户端空闲并结束客户端更新。');
  const verified = (index) =>
    verifyServerIndex(JSON.stringify(index), { keys, now: now(), replay });
  const send = async (config, method, path, body, controller) => {
    try {
      return await request(config, method, path, body, resolveProxy, controller.signal);
    } catch (error) {
      // Transport errors may include URLs or HTTP details; never relay arbitrary error text from a peer.
      if (error?.status === 404)
        throw new Error(
          '旧服务端尚未启用配套管理，需首次接入：请打开 CC管理中心的客户端更新页，在 Ubuntu 控制台运行一次接入命令。',
        );
      if (error?.status === 409) throw new Error('服务繁忙或发布目标已变化，请重新检查后确认。');
      throw new Error('服务管理网络请求失败；服务重启期间可稍候查询状态。');
    }
  };
  const run = async (fn) => {
    requireValue(!operation, '服务管理请求正在进行。');
    const controller = new AbortController(),
      ownGeneration = generation;
    operation = controller;
    try {
      return await fn(controller, () =>
        requireValue(ownGeneration === generation, '服务管理操作已取消。'),
      );
    } finally {
      if (operation === controller) operation = undefined;
    }
  };
  return {
    busy,
    cancel() {
      generation++;
      operation?.abort();
      confirmation = undefined;
      tracking = undefined;
      activeUntil = 0;
    },
    async check(input) {
      const config = connection(input);
      idle();
      requireValue(!busy(), '服务管理请求正在进行。');
      confirmation = undefined;
      tracking = undefined;
      return run(async (controller, alive) => {
        const result = await send(
          config,
          'POST',
          '/cc-managed/server/v1/check',
          { clientProtocol: PROTOCOL_VERSION },
          controller,
        );
        alive();
        strictObject(result, ['schema', 'current', 'candidate', 'index', 'compatible', 'reason']);
        currentProgram(result.current);
        requireValue(
          result.schema === 1 &&
            reasons.includes(result.reason) &&
            typeof result.compatible === 'boolean',
          '无效服务检查结果。',
        );
        let signed;
        if (result.index !== null) {
          signed = verified(result.index);
          requireValue(
            isDeepStrictEqual(result.candidate, signed.payload.release),
            '发布目标与签名不一致。',
          );
          replay = signed.replay;
          writeReplay(replay);
        } else requireValue(result.candidate === null, '发布目标缺少签名。');
        if (result.reason === 'available') {
          requireValue(
            signed && result.compatible && result.candidate.protocol === PROTOCOL_VERSION,
            '发布目标协议不匹配。',
          );
          requireValue(
            result.current.protocol <= PROTOCOL_VERSION &&
              result.candidate.build > result.current.build,
            '服务端较新或没有更高的兼容构建，请安装最新客户端；不能降级。',
          );
          confirmation = {
            binding: binding(config),
            index: signed.envelope,
            release: signed.payload.release,
          };
        } else requireValue(!result.compatible || result.reason === 'current', '无效兼容性结果。');
        return result;
      });
    },
    async install(input) {
      const config = connection(input, true);
      idle();
      return run(async (controller, alive) => {
        const exact = confirmation;
        requireValue(
          exact &&
            exact.binding === binding(config) &&
            exact.release.build === input.build &&
            exact.release.sha256 === input.sha256,
          '请重新检查并确认精确构建。',
        );
        const signed = verified(exact.index);
        requireValue(
          isDeepStrictEqual(signed.payload.release, exact.release),
          '确认的发布目标已变化。',
        );
        confirmation = undefined;
        tracking = { ...exact, observed: false };
        activeUntil = now() + 8 * 60000;
        const result = await send(
          config,
          'POST',
          '/cc-managed/server/v1/install',
          {
            clientProtocol: PROTOCOL_VERSION,
            confirmed: true,
            build: input.build,
            sha256: input.sha256,
          },
          controller,
        );
        alive();
        strictObject(result, ['accepted', 'build', 'sha256']);
        requireValue(
          result.accepted === true &&
            result.build === input.build &&
            result.sha256 === input.sha256,
          '服务端接受的目标与确认不一致。',
        );
        tracking.observed = true;
        return result;
      });
    },
    async status(input) {
      const config = connection(input);
      idle();
      requireValue(tracking && tracking.binding === binding(config), '请先确认本次服务端升级。');
      return run(async (controller, alive) => {
        const exact = tracking;
        const result = await send(
          config,
          'GET',
          '/cc-managed/server/v1/status',
          undefined,
          controller,
        );
        alive();
        strictObject(
          result,
          result.error === undefined
            ? ['schema', 'phase', 'current', 'target']
            : ['schema', 'phase', 'current', 'target', 'error'],
        );
        currentProgram(result.current);
        requireValue(
          result.schema === 1 &&
            phases.includes(result.phase) &&
            (result.error === undefined ||
              (typeof result.error === 'string' && /^[a-z0-9-]{1,100}$/.test(result.error))),
          '无效升级状态。',
        );
        requireValue(
          result.target === null || isDeepStrictEqual(result.target, exact.release),
          '升级状态的发布目标已变化。',
        );
        if (result.phase === 'committed')
          requireValue(
            result.current.build === exact.release.build &&
              result.current.sha256 === exact.release.sha256 &&
              result.current.protocol === PROTOCOL_VERSION &&
              result.current.appVersion === exact.release.appVersion,
            '升级完成状态与确认目标不一致。',
          );
        if (['failed', 'rolled-back'].includes(result.phase))
          requireValue(
            exact.observed,
            '服务管理网络请求失败；尚不能确认这是本次升级结果，正在等待可验证状态。',
          );
        if (
          ['staging', 'stopping', 'backup', 'switching', 'probing'].includes(result.phase) &&
          result.target !== null
        )
          exact.observed = true;
        if (['committed', 'rolled-back', 'failed'].includes(result.phase)) activeUntil = 0;
        return result;
      });
    },
  };
}
