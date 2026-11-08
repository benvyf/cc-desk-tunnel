import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { UpdateConfig } from './config.ts';
import { UpdateError, UpdateStore } from './store.ts';
import { MonitorStore } from './monitor.ts';
import { EnrollmentStore } from './enrollment.ts';
import { FreshNodes } from './fresh-nodes.ts';
import { validateMonitorReport } from '../../../packages/protocol/src/account-monitor.ts';
import { ModerationStore } from './moderation.ts';
import { PasswordAuth } from './password-auth.ts';
import { DesktopAccess } from './desktop-access.ts';
import { desktopServerUpdate } from './desktop-server-update.ts';
import { HostUpdates } from './host-updates.ts';
import { RelayConfig } from './relay-config.ts';
import { probeRelayHost, probeRelayNode } from './relay-probe.ts';
import { hostInstaller, hostEnrollmentCommand } from './host-updater-package.ts';
import { authenticateNode, moderationPath, NodeReviews } from './moderation-nodes.ts';
import {
  ServerDistribution,
  SERVER_INDEX_PATH,
  bootstrapCommand,
  baseUpgradeCommand,
  upgradeCommand,
} from './server-distribution.ts';

const base = '/cc-updates/admin';
const api = base + '/api';
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared && Number(declared) > limit) throw new UpdateError(413, 'Request body too large.');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > limit) throw new UpdateError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function respond(response: ServerResponse, status: number, value?: unknown): void {
  response.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    ...(status >= 400 ? { connection: 'close' } : {}),
  });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

export async function createUpdateServer(
  store: UpdateStore,
  config: UpdateConfig,
  probes = { host: probeRelayHost, node: probeRelayNode },
) {
  const assets = new Map<string, { bytes: Buffer; type: string }>();
  for (const [file, type] of [
    ['index.html', 'text/html'],
    ['app.js', 'text/javascript'],
    ['moderation.js', 'text/javascript'],
    ['password-login.js', 'text/javascript'],
    ['navigation.js', 'text/javascript'],
    ['enrollment.js', 'text/javascript'],
    ['monitor-install.py', 'text/plain'],
    ['server-bootstrap.py', 'text/plain'],
    ['server-upgrade.cjs', 'text/plain'],
    ['server-download.js', 'text/javascript'],
    ['fresh-install.py', 'text/plain'],
    ['fresh-install-v3.py', 'text/plain'],
    ['fresh-install-recovery.py', 'text/plain'],
    ['fresh-nodes.js', 'text/javascript'],
    ['desktop-access.js', 'text/javascript'],
    ['monitor.js', 'text/javascript'],
    ['node-updates.js', 'text/javascript'],
    ['relay.js', 'text/javascript'],
    ['style.css', 'text/css'],
  ]) {
    assets.set(file === 'index.html' ? base + '/' : `${base}/${file}`, {
      bytes: await readFile(new URL(`../web/${file}`, import.meta.url)),
      type: type!,
    });
  }
  assets.set(`${base}/fresh-install-v4.py`, assets.get(`${base}/fresh-install.py`)!);
  for (const page of ['accounts', 'updates', 'moderation'])
    assets.set(`${base}/${page}`, assets.get(base + '/')!);
  const expectedTokenHash = Buffer.from(config.adminTokenSha256, 'hex');
  const distribution = new ServerDistribution(config.dataDir, config.trustedKeys);
  const freshNodes = new FreshNodes(config);
  const nodeHashes = () => ({ ...config.monitorNodes, ...freshNodes.monitorNodes() });
  const hostUpdates = new HostUpdates(config.dataDir, () => Object.keys(nodeHashes()));
  const installer = await hostInstaller(config);
  assets.set(base + '/host-updater-install.py', { bytes: installer, type: 'text/plain' });
  let monitor = Object.keys(nodeHashes()).length
    ? new MonitorStore(config.dataDir, Object.keys(nodeHashes()))
    : undefined;
  const passwordAuth = new PasswordAuth(join(config.dataDir, 'private'));
  const desktopAccess = new DesktopAccess(config.dataDir);
  const relayConfig = new RelayConfig(config.dataDir, desktopAccess, () =>
    Object.keys(nodeHashes()),
  );
  const verifying = new Map<string, Promise<void>>();
  let relayClosed = false;
  const relayPreflights = new Map<string, number>();
  function verifyRelay(id: string, revision: number) {
    if (verifying.has(id)) return verifying.get(id)!;
    const task = (async () => {
      const proof = relayConfig.verification(id, revision);
      await probes.node(proof.url, proof.target.fingerprint);
      if (!relayClosed) relayConfig.verified(id, revision);
    })()
      .catch(() => {
        if (!relayClosed) relayConfig.verificationFailed(id, revision);
      })
      .finally(() => verifying.delete(id));
    verifying.set(id, task);
    return task;
  }
  const enrollment = new EnrollmentStore(config);
  let failures = 0;
  let windowStart = Date.now();
  function resetFailureWindow() {
    if (Date.now() - windowStart > 60000) {
      failures = 0;
      windowStart = Date.now();
    }
  }
  function checkOrigin(request: IncomingMessage) {
    const origin = request.headers.origin;
    if (
      (request.method !== 'GET' && origin !== config.origin) ||
      (origin !== undefined && origin !== config.origin)
    )
      throw new UpdateError(403, 'Invalid request origin.');
  }
  function authenticated(request: IncomingMessage): void {
    resetFailureWindow();
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (
      !/^[A-Za-z0-9_-]{32,128}$/.test(token) ||
      (!timingSafeEqual(createHash('sha256').update(token).digest(), expectedTokenHash) &&
        !passwordAuth.accepts(token))
    ) {
      if (failures >= 30)
        throw new UpdateError(429, 'Too many failed authentication attempts; retry later.');
      failures++;
      throw new UpdateError(401, 'Administrator authentication required.');
    }
    checkOrigin(request);
  }
  function contentType(request: IncomingMessage, type: string): void {
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== type)
      throw new UpdateError(415, 'Unsupported content type.');
  }

  const moderation = await ModerationStore.open(config.dataDir);
  const nodeReviews = new NodeReviews();
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 600000, headersTimeout: 15000, keepAliveTimeout: 5000 },
    (request, response) => {
      void (async () => {
        if (!request.url?.startsWith('/') || request.url.length > 2048)
          throw new UpdateError(404, 'Not found.');
        const url = new URL(request.url, 'http://localhost');
        if (url.search) throw new UpdateError(404, 'Not found.');
        const path = url.pathname;
        if (path === '/cc-host/v1/relay') {
          if (request.method !== 'POST' || request.headers.origin !== undefined)
            throw new UpdateError(403, 'Host channel request required.');
          contentType(request, 'application/json');
          let input;
          try {
            input = JSON.parse((await body(request, 4096)).toString('utf8'));
          } catch {
            throw new UpdateError(400, 'Invalid relay JSON.');
          }
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).sort().join(',') !== 'inventory,nodeId,report' ||
            typeof input.nodeId !== 'string'
          )
            throw new UpdateError(400, 'Invalid relay report.');
          hostUpdates.authorize(
            input.nodeId,
            request.headers.authorization?.replace(/^Bearer /, '') ?? '',
          );
          const result = relayConfig.poll(input.nodeId, {
            inventory: input.inventory,
            report: input.report,
          });
          respond(response, 200, result);
          if (input.report?.state === 'applied')
            void verifyRelay(input.nodeId, input.report.revision);
          return;
        }
        if (path === '/cc-host/v1/enroll' || path === '/cc-host/v1/poll') {
          if (request.method !== 'POST' || request.headers.origin !== undefined)
            throw new UpdateError(403, 'Host channel request required.');
          contentType(request, 'application/json');
          let input: unknown;
          try {
            input = JSON.parse((await body(request, 8192)).toString('utf8'));
          } catch {
            throw new UpdateError(400, 'Invalid host channel JSON.');
          }
          const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
          respond(
            response,
            200,
            path.endsWith('/enroll') ? hostUpdates.enroll(input) : hostUpdates.poll(token, input),
          );
          return;
        }
        if (path.startsWith('/cc-access/v1/')) {
          if (request.headers.origin !== undefined && request.headers.origin !== config.origin)
            throw new UpdateError(403, 'Invalid request origin.');
          const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
          if (path === '/cc-access/v1/workspaces' && request.method === 'GET') {
            respond(response, 200, { workspaces: desktopAccess.workspaces(bearer) });
            return;
          }
          if (request.method !== 'POST') throw new UpdateError(405, 'Method not allowed.');
          contentType(request, 'application/json');
          let input: Record<string, unknown>;
          try {
            input = JSON.parse((await body(request, 4096)).toString('utf8'));
          } catch {
            throw new UpdateError(400, 'Invalid JSON.');
          }
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new UpdateError(400, 'Invalid request.');
          if (path === '/cc-access/v1/login') {
            const remote = request.socket.remoteAddress ?? 'unknown';
            const forwarded = request.headers['x-real-ip'];
            // Production only listens on loopback; Nginx overwrites this header.
            const address =
              ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) &&
              typeof forwarded === 'string' &&
              isIP(forwarded)
                ? forwarded
                : remote;
            respond(response, 200, await desktopAccess.login(input, address));
          } else if (path === '/cc-access/v1/connect') {
            if (typeof input.nodeId !== 'string') throw new UpdateError(400, '请选择工作空间。');
            respond(response, 200, desktopAccess.connect(bearer, input.nodeId));
          } else if (/^\/cc-access\/v1\/server\/(check|install|status)$/.test(path)) {
            respond(
              response,
              200,
              await desktopServerUpdate(desktopAccess, bearer, path.split('/').at(-1)!, input),
            );
          } else if (path === '/cc-access/v1/logout') {
            desktopAccess.logout(bearer);
            respond(response, 204);
          } else if (path === '/cc-access/v1/validate') {
            if (request.headers.origin !== undefined)
              throw new UpdateError(403, 'Node request required.');
            const expected =
              typeof input.nodeId === 'string' && Object.hasOwn(nodeHashes(), input.nodeId)
                ? nodeHashes()[input.nodeId]
                : undefined;
            if (
              !expected ||
              !/^[A-Za-z0-9_-]{32,128}$/.test(bearer) ||
              !timingSafeEqual(
                createHash('sha256').update(bearer).digest(),
                Buffer.from(expected, 'hex'),
              )
            )
              throw new UpdateError(401, 'Node authentication required.');
            if (
              typeof input.ticket !== 'string' ||
              input.ticket.length > 128 ||
              typeof input.renewal !== 'boolean'
            )
              throw new UpdateError(400, 'Invalid ticket.');
            respond(
              response,
              200,
              desktopAccess.validate(input.ticket, String(input.nodeId), input.renewal),
            );
          } else throw new UpdateError(404, 'Not found.');
          return;
        }
        if (path === SERVER_INDEX_PATH || path.startsWith('/cc-updates/server/v1/artifacts/')) {
          if (request.method !== 'GET' && request.method !== 'HEAD')
            throw new UpdateError(405, 'Method not allowed.');
          if (request.url !== path) throw new UpdateError(404, 'Not found.');
          const bytes =
            path === SERVER_INDEX_PATH ? distribution.index() : distribution.artifact(path);
          if (!bytes) throw new UpdateError(404, 'No signed Linux release published.');
          response.writeHead(200, {
            ...headers,
            'content-type': path === SERVER_INDEX_PATH ? 'application/json' : 'application/gzip',
            'content-length': bytes.length,
            'cache-control':
              path === SERVER_INDEX_PATH ? 'no-store' : 'public, max-age=31536000, immutable',
          });
          response.end(request.method === 'HEAD' ? undefined : bytes);
          return;
        }
        const asset = assets.get(path);
        if (asset) {
          if (request.method !== 'GET' && request.method !== 'HEAD')
            throw new UpdateError(405, 'Method not allowed.');
          response.writeHead(200, {
            ...headers,
            'content-type': asset.type + '; charset=utf-8',
            'content-length': asset.bytes.length,
          });
          response.end(request.method === 'HEAD' ? undefined : asset.bytes);
          return;
        }
        const channel = /^\/cc-updates\/v1\/channels\/(pilot|stable)\/win32-x64\.json$/.exec(path);
        if (channel) {
          if (request.method !== 'GET' && request.method !== 'HEAD')
            throw new UpdateError(405, 'Method not allowed.');
          const bytes = store.channel(channel[1]!);
          if (!bytes) throw new UpdateError(404, 'No signed index published.');
          response.writeHead(200, {
            ...headers,
            'content-type': 'application/json',
            'content-length': bytes.length,
          });
          response.end(request.method === 'HEAD' ? undefined : bytes);
          return;
        }
        if (path === moderationPath) {
          if (request.method !== 'POST') throw new UpdateError(405, 'Method not allowed.');
          const node = await authenticateNode(config.dataDir, request.headers.authorization);
          contentType(request, 'application/json');
          let input: unknown;
          try {
            input = JSON.parse((await body(request, 400 * 1024)).toString('utf8'));
          } catch (error) {
            if (error instanceof UpdateError) throw error;
            throw new UpdateError(400, 'Invalid review JSON.');
          }
          respond(response, 200, await nodeReviews.check(node, input, moderation));
          return;
        }
        if (!path.startsWith(api + '/')) throw new UpdateError(404, 'Not found.');
        if (path === `${api}/fresh-nodes/redeem` && request.method === 'POST') {
          if (request.headers.origin !== undefined)
            throw new UpdateError(403, 'Browser redemption is not accepted.');
          contentType(request, 'application/json');
          let input;
          try {
            input = JSON.parse((await body(request, 256)).toString('utf8'));
          } catch {
            throw new UpdateError(400, 'Invalid installation identity.');
          }
          if (
            !input ||
            Array.isArray(input) ||
            Object.keys(input).length !== 1 ||
            !Object.hasOwn(input, 'installationId')
          )
            throw new UpdateError(400, 'Expected installation identity.');
          const auth = request.headers.authorization ?? '';
          const bundle = freshNodes.redeem(
            auth.startsWith('Bearer ') ? auth.slice(7) : '',
            input.installationId,
          );
          monitor ??= new MonitorStore(config.dataDir, Object.keys(nodeHashes()));
          monitor.addNode(bundle.nodeId);
          respond(response, 200, bundle);
          return;
        }
        if (path === `${api}/monitor/enrollment/redeem` && request.method === 'POST') {
          if (request.headers.origin !== undefined)
            throw new UpdateError(403, 'Browser redemption is not accepted.');
          contentType(request, 'application/json');
          if ((await body(request, 16)).toString('utf8') !== '{}')
            throw new UpdateError(400, 'Expected empty JSON object.');
          const authorization = request.headers.authorization ?? '';
          const bytes = await enrollment.redeem(
            authorization.startsWith('Bearer ') ? authorization.slice(7) : '',
          );
          response.writeHead(200, {
            ...headers,
            'content-type': 'application/octet-stream',
            'content-length': bytes.length,
          });
          response.end(bytes);
          return;
        }
        if (path === `${api}/monitor/report` && request.method === 'POST') {
          if (!monitor) throw new UpdateError(404, 'Monitoring is not configured.');
          if (request.headers.origin !== undefined)
            throw new UpdateError(403, 'Browser reports are not accepted.');
          contentType(request, 'application/json');
          let input: unknown;
          try {
            input = JSON.parse((await body(request, 16384)).toString('utf8'));
          } catch (error) {
            if (error instanceof UpdateError) throw error;
            throw new UpdateError(400, 'Invalid report.');
          }
          const nodeId =
            input && typeof input === 'object' && !Array.isArray(input)
              ? (input as Record<string, unknown>).nodeId
              : undefined;
          const expected =
            typeof nodeId === 'string' && Object.hasOwn(nodeHashes(), nodeId)
              ? nodeHashes()[nodeId]
              : undefined;
          const auth = request.headers.authorization ?? '';
          const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
          if (
            !expected ||
            !/^[A-Za-z0-9_-]{32,128}$/.test(token) ||
            !timingSafeEqual(
              createHash('sha256').update(token).digest(),
              Buffer.from(expected, 'hex'),
            )
          )
            throw new UpdateError(401, 'Node authentication required.');
          try {
            const report = validateMonitorReport(input);
            if (
              report.schema === 2 &&
              report.account &&
              createHash('sha256')
                .update(report.account.email!.trim().toLowerCase())
                .digest('hex') !== report.account.id
            )
              throw new Error('Identity mismatch');
            monitor.put(report);
          } catch {
            throw new UpdateError(400, 'Invalid report.');
          }
          respond(response, 204);
          return;
        }

        if (
          (path === `${api}/auth/login` || path === `${api}/auth/setup`) &&
          request.method === 'POST'
        ) {
          checkOrigin(request);
          contentType(request, 'application/json');
          resetFailureWindow();
          if (failures >= 30) throw new UpdateError(429, '登录失败次数过多，请一分钟后重试。');
          let input;
          try {
            input = JSON.parse((await body(request, 2048)).toString('utf8'));
          } catch (error) {
            if (error instanceof UpdateError) throw error;
            throw new UpdateError(400, 'Invalid login JSON.');
          }
          const setup = path.endsWith('/setup');
          const fields = setup ? ['setupToken', 'password'] : ['password'];
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).length !== fields.length ||
            !fields.every((field) => Object.hasOwn(input, field))
          )
            throw new UpdateError(400, 'Invalid login fields.');
          let sessionToken;
          try {
            sessionToken = setup
              ? await passwordAuth.setup(input.setupToken, input.password)
              : await passwordAuth.login(input.password);
          } catch (error) {
            if (error instanceof UpdateError && error.status === 401) failures++;
            throw error;
          }
          if (!sessionToken) {
            failures++;
            throw new UpdateError(401, '密码不正确，请重新输入。');
          }
          respond(response, 200, { sessionToken, expiresInSeconds: 28800 });
          return;
        }
        authenticated(request);
        if (path === `${api}/relay` && request.method === 'GET') {
          respond(response, 200, relayConfig.status());
          return;
        }
        if ([`${api}/relay/preview`, `${api}/relay/publish`].includes(path)) {
          if (request.method !== 'POST') throw new UpdateError(405, 'Method not allowed.');
          contentType(request, 'application/json');
          let input;
          try {
            input = JSON.parse((await body(request, 4096)).toString('utf8'));
          } catch {
            throw new UpdateError(400, 'Invalid relay JSON.');
          }
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new UpdateError(400, 'Invalid relay request.');
          if (path.endsWith('/preview')) {
            if (Object.keys(input).sort().join(',') !== 'host,nodes')
              throw new UpdateError(400, '请选择目标 IP 和节点。');
            const preview = relayConfig.preview(input.host, input.nodes);
            await probes.host(preview.host, preview.targets[0]!.inventory.hostKey);
            relayConfig.previewValue(preview.id);
            for (const [id, expiry] of relayPreflights)
              if (expiry <= Date.now()) relayPreflights.delete(id);
            relayPreflights.set(preview.id, preview.expires);
            respond(response, 200, preview);
          } else {
            if (
              Object.keys(input).sort().join(',') !== 'confirmed,previewId' ||
              input.confirmed !== true ||
              typeof input.previewId !== 'string' ||
              (relayPreflights.get(input.previewId) ?? 0) <= Date.now()
            )
              throw new UpdateError(409, '请先预检并确认具体 IP 和节点。');
            const publication = relayConfig.publish(input.previewId, config.adminName);
            relayPreflights.delete(input.previewId);
            respond(response, 202, { ...relayConfig.status(), publication });
          }
          return;
        }
        const hostNode = new RegExp(
          `^${api}/host-updates/([a-z0-9_-]{1,64})(?:/(enrollment|install))?$`,
        ).exec(path);
        if (hostNode) {
          const id = hostNode[1]!;
          const publication = distribution.status();
          if (request.method === 'GET' && !hostNode[2]) {
            respond(response, 200, {
              ...hostUpdates.status(id),
              release:
                publication.published && !publication.expired ? publication.payload.release : null,
            });
          } else if (request.method === 'POST' && hostNode[2]) {
            contentType(request, 'application/json');
            let input: unknown;
            try {
              input = JSON.parse((await body(request, 1024)).toString('utf8'));
            } catch {
              throw new UpdateError(400, 'Invalid host update JSON.');
            }
            if (hostNode[2] === 'enrollment') {
              if (
                !input ||
                typeof input !== 'object' ||
                Array.isArray(input) ||
                Object.keys(input).length
              )
                throw new UpdateError(400, 'Invalid enrollment request.');
              const grant = hostUpdates.issue(id);
              respond(response, 200, {
                expiresAt: grant.expiresAt,
                command: hostEnrollmentCommand(config.origin, installer, id, grant.code),
              });
            } else {
              if (!publication.published || publication.expired)
                throw new UpdateError(409, '请先发布有效的已签名 Linux 服务端。');
              respond(
                response,
                202,
                hostUpdates.enqueue(
                  id,
                  input,
                  publication.payload.release,
                  JSON.parse(distribution.index()!.toString('utf8')),
                ),
              );
            }
          } else throw new UpdateError(405, 'Method not allowed.');
          return;
        }
        if (path === `${api}/desktop-access` && request.method === 'GET') {
          respond(response, 200, desktopAccess.status(Object.keys(nodeHashes())));
          return;
        }
        const accessNode = new RegExp(`^${api}/desktop-access/nodes/([a-z0-9_-]+)$`).exec(path);
        const accessUser = new RegExp(`^${api}/desktop-access/users(?:/([a-f0-9-]+))?$`).exec(path);
        if ((accessNode && request.method === 'PUT') || (accessUser && request.method === 'POST')) {
          contentType(request, 'application/json');
          let input;
          try {
            input = JSON.parse((await body(request, 8192)).toString('utf8'));
          } catch {
            throw new UpdateError(400, 'Invalid JSON.');
          }
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new UpdateError(400, 'Invalid request.');
          if (accessNode) {
            desktopAccess.saveNode(accessNode[1]!, input, Object.keys(nodeHashes()));
            console.log('Desktop connection updated', {
              administrator: config.adminName,
              nodeId: accessNode[1],
            });
          } else {
            const userId = await desktopAccess.saveUser(
              accessUser![1],
              input,
              Object.keys(nodeHashes()),
            );
            console.log('Desktop user updated; sessions revoked', {
              administrator: config.adminName,
              userId,
            });
          }
          respond(response, 200, desktopAccess.status(Object.keys(nodeHashes())));
          return;
        }
        if (path === `${api}/fresh-nodes` && request.method === 'POST') {
          contentType(request, 'application/json');
          let input;
          try {
            input = JSON.parse((await body(request, 1024)).toString('utf8'));
          } catch {
            throw new UpdateError(400, 'Invalid node JSON.');
          }
          respond(response, 201, freshNodes.issue(input, distribution));
          return;
        }
        if (path === `${api}/server` && request.method === 'GET') {
          const status = distribution.status();
          respond(response, 200, {
            ...status,
            ...(status.published && !status.expired
              ? {
                  command: bootstrapCommand(
                    status.payload.release,
                    createHash('sha256')
                      .update(assets.get(base + '/server-bootstrap.py')!.bytes)
                      .digest('hex'),
                  ),
                  upgradeCommand: upgradeCommand(
                    status.payload.release,
                    assets.get(base + '/server-upgrade.cjs')!.bytes,
                  ),
                  baseUpgradeCommand: baseUpgradeCommand(
                    status.payload.release,
                    await readFile(
                      new URL(
                        status.payload.release.build === 10
                          ? '../../../scripts/upgrade-runtime-base.py'
                          : status.payload.release.build === 9
                            ? '../../../scripts/upgrade-message-review.py'
                            : '../../../scripts/upgrade-terminal-base.py',
                        import.meta.url,
                      ),
                    ),
                    await readFile(
                      new URL('../../../scripts/install-cc-space-037.py', import.meta.url),
                    ),
                    assets.get(base + '/server-bootstrap.py')!.bytes,
                    assets.get(base + '/fresh-install.py')!.bytes,
                    await readFile(
                      new URL('../../../scripts/upgrade-message-review.py', import.meta.url),
                    ),
                  ),
                }
              : {}),
          });
          return;
        }
        if (path === `${api}/monitor/enrollment` && request.method === 'GET') {
          respond(response, 200, enrollment.status());
          return;
        }
        if (path === `${api}/monitor/enrollment` && request.method === 'POST') {
          contentType(request, 'application/json');
          let input: unknown;
          try {
            input = JSON.parse((await body(request, 256)).toString('utf8'));
          } catch (error) {
            if (error instanceof UpdateError) throw error;
            throw new UpdateError(400, 'Invalid enrollment JSON.');
          }
          respond(response, 201, enrollment.issue(input));
          return;
        }
        if (path === `${api}/monitor` && request.method === 'GET') {
          respond(
            response,
            200,
            monitor?.status() ?? { nodes: [], configuredNodes: [], accounts: [] },
          );
          return;
        }
        const accountNote = new RegExp(`^${api}/monitor/accounts/([a-f0-9]{64})/note$`).exec(path);
        if (accountNote && request.method === 'PUT') {
          contentType(request, 'application/json');
          let input: unknown;
          try {
            input = JSON.parse((await body(request, 8192)).toString('utf8'));
          } catch (error) {
            if (error instanceof UpdateError) throw error;
            throw new UpdateError(400, 'Invalid account note.');
          }
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).length !== 1 ||
            !Object.hasOwn(input, 'note')
          )
            throw new UpdateError(400, 'Invalid account note.');
          const note = (input as { note: unknown }).note;
          if (
            typeof note !== 'string' ||
            note.length > 2000 ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)
          )
            throw new UpdateError(400, 'Account note must contain at most 2000 characters.');
          if (!monitor?.note(accountNote[1]!, note)) throw new UpdateError(404, 'Unknown account.');
          respond(response, 204);
          return;
        }

        if (path === `${api}/auth/password` && request.method === 'POST') {
          contentType(request, 'application/json');
          if (failures >= 30) throw new UpdateError(429, '密码验证失败次数过多，请一分钟后重试。');
          let input;
          try {
            input = JSON.parse((await body(request, 2048)).toString('utf8'));
          } catch (error) {
            if (error instanceof UpdateError) throw error;
            throw new UpdateError(400, 'Invalid password JSON.');
          }
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).length !== 2 ||
            !Object.hasOwn(input, 'currentPassword') ||
            !Object.hasOwn(input, 'newPassword')
          )
            throw new UpdateError(400, 'Invalid password fields.');
          const sessionToken = await passwordAuth.changePassword(
            input.currentPassword,
            input.newPassword,
          );
          if (!sessionToken) {
            failures++;
            throw new UpdateError(400, '当前密码不正确，请重新输入。');
          }
          respond(response, 200, { sessionToken, expiresInSeconds: 28800 });
          return;
        }
        if (path === `${api}/auth/logout` && request.method === 'POST') {
          passwordAuth.logout((request.headers.authorization ?? '').slice(7));
          respond(response, 204);
          return;
        }
        if (path === `${api}/moderation/config` && request.method === 'GET') {
          respond(response, 200, moderation.config());
          return;
        }
        if (path === `${api}/moderation/events` && request.method === 'GET') {
          respond(response, 200, moderation.events());
          return;
        }
        if (path === `${api}/moderation/usage` && request.method === 'GET') {
          respond(response, 200, moderation.usage());
          return;
        }
        if (
          (path === `${api}/moderation/config` && request.method === 'PUT') ||
          (path === `${api}/moderation/preview` && request.method === 'POST')
        ) {
          contentType(request, 'application/json');
          let input: unknown;
          try {
            input = JSON.parse((await body(request, 128 * 1024)).toString('utf8'));
          } catch (error) {
            if (error instanceof UpdateError) throw error;
            throw new UpdateError(400, 'Invalid moderation JSON.');
          }
          if (request.method === 'PUT')
            respond(response, 200, moderation.save(input, config.adminName));
          else {
            if (
              !input ||
              typeof input !== 'object' ||
              Array.isArray(input) ||
              Object.keys(input).length !== 1 ||
              !Object.hasOwn(input, 'text')
            )
              throw new UpdateError(400, 'Expected text field only.');
            respond(
              response,
              200,
              await moderation.preview((input as { text: unknown }).text, config.adminName),
            );
          }
          return;
        }
        if (path === `${api}/status` && request.method === 'GET') {
          respond(response, 200, store.status());
          return;
        }
        if (path === `${api}/candidates` && request.method === 'POST') {
          contentType(request, 'application/json');
          respond(response, 201, await store.createCandidate(await body(request, 64 * 1024)));
          return;
        }
        const match =
          /^\/cc-updates\/admin\/api\/candidates\/([a-f0-9-]{36})(?:\/(artifact|activate))?$/.exec(
            path,
          );
        if (match) {
          const id = match[1]!;
          const action = match[2];
          if (action === 'artifact' && request.method === 'PUT') {
            contentType(request, 'application/octet-stream');
            await store.upload(id, Readable.from(request.iterator({ destroyOnReturn: false })));
            respond(response, 204);
            return;
          }
          if (action === 'activate' && request.method === 'POST') {
            contentType(request, 'application/json');
            let input: unknown;
            try {
              input = JSON.parse((await body(request, 128)).toString('utf8'));
            } catch (error) {
              if (error instanceof UpdateError) throw error;
              throw new UpdateError(400, 'Expected empty JSON object.');
            }
            if (
              !input ||
              typeof input !== 'object' ||
              Array.isArray(input) ||
              Object.keys(input).length
            )
              throw new UpdateError(400, 'Expected empty JSON object.');
            respond(response, 200, await store.activate(id));
            return;
          }
          if (!action && request.method === 'DELETE') {
            await store.removeCandidate(id);
            respond(response, 204);
            return;
          }
        }
        throw new UpdateError(404, 'Not found.');
      })().catch((error: unknown) => {
        const incidentId = error instanceof UpdateError ? undefined : randomUUID();
        if (incidentId)
          console.error('Management request failed.', {
            incidentId,
            // Omit exception messages: a provider or configuration error may contain secrets.
            frames:
              error instanceof Error ? error.stack?.split('\n').slice(1).join('\n') : undefined,
          });
        if (!response.headersSent && !response.destroyed)
          respond(response, error instanceof UpdateError ? error.status : 500, {
            error: error instanceof UpdateError ? error.message : 'Internal service error.',
            ...(incidentId ? { incidentId } : {}),
          });
        else response.destroy();
      });
    },
  );
  server.maxHeadersCount = 32;
  server.once('close', () => monitor?.close());
  server.once('close', () => moderation.close());
  server.once('close', () => desktopAccess.close());
  server.once('close', () => hostUpdates.close());
  server.once('close', () => {
    relayClosed = true;
    relayConfig.close();
  });
  return server;
}
