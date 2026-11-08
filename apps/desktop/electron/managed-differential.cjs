'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const {
  GenericDifferentialDownloader,
  computeOperations,
  OperationKind,
  HttpExecutor,
  CancellationToken,
  CancellationError,
  version,
} = require('./managed-differential-engine.cjs');
if (version !== '6.8.10') throw new Error('Unsupported differential engine version');
const logger = { info() {}, warn() {}, error() {} };

function estimateDifferential(oldMap, newMap) {
  if (oldMap.version !== newMap.version) throw new Error('Incompatible blockmaps');
  const result = { downloadBytes: 0, copyBytes: 0 };
  for (const operation of computeOperations(oldMap, newMap, logger)) {
    const length = operation.end - operation.start;
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      !Number.isSafeInteger(operation.start) ||
      operation.start < 0
    )
      throw new Error('Invalid differential operation');
    result[operation.kind === OperationKind.DOWNLOAD ? 'downloadBytes' : 'copyBytes'] += length;
  }
  return result;
}

async function safePath(filename, output = false) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename))
    throw new Error('Absolute differential file path required');
  const resolved = path.resolve(filename);
  let current = resolved;
  let leaf = true;
  while (true) {
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!(output && leaf && error.code === 'ENOENT')) throw error;
    }
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error('Unsafe differential file link');
      if (leaf ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
        throw new Error('Unsafe differential file path');
      if (leaf && output) throw new Error('Differential output must be a new private file');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    leaf = false;
  }
  return resolved;
}

class StrictExecutor extends HttpExecutor {
  constructor(target, size, createRequest, token) {
    super();
    this.target = target;
    this.size = size;
    this.requestFactory = createRequest;
    this.token = token;
    this.active = new Map();
    this.failure = null;
  }
  fail(error) {
    if (!this.failure) this.failure = error;
    this.token.cancel();
    for (const [request, state] of this.active) {
      state.reject?.(this.failure);
      clearTimeout(state.timer);
      state.validated?.destroy();
      state.response?.destroy();
      try {
        request.abort();
      } catch {
        /* already closed */
      }
    }
  }
  addErrorAndTimeoutHandlers(request, reject) {
    // The SDK's reject must be installed before end()/the response event.
    const state = this.active.get(request);
    state.reject = reject;
    if (this.failure) reject(this.failure);
  }
  createRequest(options, callback) {
    if (this.failure) throw this.failure;
    if (this.token.cancelled) throw new CancellationError();
    const candidate = new URL(
      `${options.protocol}//${options.hostname}${options.port ? ':' + options.port : ''}${options.path}`,
    );
    if (candidate.href !== this.target.href || options.auth)
      throw new Error('Differential request target changed');
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range || '');
    if (!match) throw new Error('Single byte range required');
    const start = Number(match[1]),
      end = Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= this.size
    )
      throw new Error('Invalid differential range');
    const expected = end - start + 1;
    const request = this.requestFactory({
      url: this.target.href,
      headers: { ...options.headers, 'accept-encoding': 'identity' },
    });
    const state = { reject: null, response: null, validated: null, timer: null, ended: false };
    this.active.set(request, state);
    const touch = () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(
        () => this.fail(new Error('Differential request inactivity timeout')),
        20_000,
      );
    };
    const fail = (error) =>
      this.fail(error instanceof Error ? error : new Error('Differential request failed'));
    request.on('error', fail);
    request.prependListener('redirect', () => {
      // The SDK also handles this event. Its followRedirect call must fail too.
      fail(new Error('Differential redirects are forbidden'));
    });
    request.followRedirect = () => fail(new Error('Differential redirects are forbidden'));
    request.on('abort', () => {
      if (!state.ended && !this.failure) fail(new Error('Differential request aborted'));
    });
    request.on('close', () => {
      // Electron request close is not a response-body completion signal.
      // Keep tracking until validated end, explicit failure, or inactivity timeout.
      if (state.ended || this.failure) {
        clearTimeout(state.timer);
        this.active.delete(request);
      }
    });
    request.on('response', (response) => {
      state.response = response;
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('Differential response aborted')));
      if (this.failure) {
        response.destroy();
        return;
      }
      try {
        const header = (name) => {
          const value = response.headers[name];
          if (Array.isArray(value)) {
            if (value.length !== 1) throw new Error('Ambiguous differential response header');
            return value[0];
          }
          return value;
        };
        const encoding = header('content-encoding');
        if (
          response.statusCode !== 206 ||
          header('content-range') !== `bytes ${start}-${end}/${this.size}` ||
          String(header('content-length')) !== String(expected) ||
          (encoding != null && encoding !== 'identity')
        )
          throw new Error('Invalid differential Range response');
        let received = 0;
        const validated = new Transform({
          transform(chunk, encoding, done) {
            received += chunk.length;
            touch();
            done(
              received > expected ? new Error('Differential response exceeds range') : null,
              chunk,
            );
          },
          flush(done) {
            done(received !== expected ? new Error('Differential response is short') : null);
          },
        });
        state.validated = validated;
        validated.statusCode = 206;
        validated.headers = response.headers;
        validated.on('error', fail);
        validated.once('end', () => {
          state.ended = true;
          clearTimeout(state.timer);
          this.active.delete(request);
        });
        response.once('close', () => {
          if (!response.readableEnded && !this.failure)
            fail(new Error('Differential response closed early'));
        });
        callback(validated);
        response.pipe(validated);
        touch();
      } catch (error) {
        fail(error);
      }
    });
    touch();
    return request;
  }
  dispose() {
    for (const [request, state] of this.active) {
      clearTimeout(state.timer);
      state.validated?.destroy();
      state.response?.destroy();
      try {
        request.abort();
      } catch {
        /* already closed */
      }
    }
    this.active.clear();
  }
}

async function runDifferential(options) {
  const { oldFile, newFile, oldBlockMap, newBlockMap, signal, size, sha512, createRequest } =
    options;
  if (signal?.aborted) throw new CancellationError();
  const target = new URL(options.newUrl);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error('Unsafe differential URL');
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    typeof sha512 !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(sha512) ||
    typeof createRequest !== 'function'
  )
    throw new Error('Invalid differential information');
  if (path.resolve(oldFile).toLowerCase() === path.resolve(newFile).toLowerCase())
    throw new Error('Differential output equals source');
  const plan = estimateDifferential(oldBlockMap, newBlockMap);
  if (plan.downloadBytes + plan.copyBytes !== size)
    throw new Error('Differential target size mismatch');
  await safePath(oldFile);
  await safePath(newFile, true);
  if (signal?.aborted) throw new CancellationError();
  const token = new CancellationToken();
  const executor = new StrictExecutor(target, size, createRequest, token);
  const abort = () => executor.fail(new CancellationError());
  signal?.addEventListener('abort', abort, { once: true });
  const totalTimer = setTimeout(
    () => executor.fail(new Error('Differential total timeout')),
    30 * 60_000,
  );
  try {
    const downloader = new GenericDifferentialDownloader({ size, sha512 }, executor, {
      oldFile,
      newFile,
      newUrl: target,
      logger,
      requestHeaders: {},
      isUseMultipleRangeRequest: false,
      cancellationToken: token,
      onProgress: (progress) => {
        try {
          options.onProgress?.(progress);
        } catch (error) {
          executor.fail(error);
        }
      },
    });
    // Await the SDK's own finally path: it closes both file descriptors before
    // rejecting. Never race this promise against cancellation and return early.
    await downloader.download(oldBlockMap, newBlockMap);
    if (executor.failure) throw executor.failure;
    if (token.cancelled) throw new CancellationError();
  } catch (error) {
    executor.fail(error);
    throw executor.failure;
  } finally {
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', abort);
    executor.dispose();
    token.dispose();
  }
}

module.exports = { runDifferential, estimateDifferential };
