import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import type { UpdateConfig } from './config.ts';
import { UpdateError, UpdateStore } from './store.ts';
import { ModerationStore } from './moderation.ts';
import { PasswordAuth } from './password-auth.ts';

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

export async function createUpdateServer(store: UpdateStore, config: UpdateConfig) {
  const assets = new Map<string, { bytes: Buffer; type: string }>();
  for (const [file, type] of [
    ['index.html', 'text/html'],
    ['app.js', 'text/javascript'],
    ['moderation.js', 'text/javascript'],
    ['password-login.js', 'text/javascript'],
    ['style.css', 'text/css'],
  ]) {
    assets.set(file === 'index.html' ? base + '/' : `${base}/${file}`, {
      bytes: await readFile(new URL(`../web/${file}`, import.meta.url)),
      type: type!,
    });
  }
  const expectedTokenHash = Buffer.from(config.adminTokenSha256, 'hex');
  const passwordAuth = new PasswordAuth(join(config.dataDir, 'private'));
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
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 600000, headersTimeout: 15000, keepAliveTimeout: 5000 },
    (request, response) => {
      void (async () => {
        if (!request.url?.startsWith('/') || request.url.length > 2048)
          throw new UpdateError(404, 'Not found.');
        const url = new URL(request.url, 'http://localhost');
        if (url.search) throw new UpdateError(404, 'Not found.');
        const path = url.pathname;
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
        if (!path.startsWith(api + '/')) throw new UpdateError(404, 'Not found.');
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
  server.once('close', () => moderation.close());
  return server;
}
