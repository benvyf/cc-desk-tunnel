const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { validateIdentity, installationId } = require('./managed-identity.cjs');

const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
function read(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
function atomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}
async function hashFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of fs.createReadStream(file)) {
    hash.update(bytes);
    size += bytes.length;
  }
  return { size, sha256: hash.digest('hex') };
}

class ManagedController {
  constructor({
    identity,
    executable,
    localAppData,
    contract,
    network,
    notify = () => {},
    quit = () => {},
    launchInstaller,
    processes,
    now = Date.now,
    lockName,
  }) {
    this.identity = validateIdentity(identity);
    this.contract = contract;
    this.network = network;
    this.notify = notify;
    this.quit = quit;
    this.launchInstaller = launchInstaller;
    this.processes = processes;
    this.now = now;
    this.directory = path.join(
      localAppData,
      'CC-Desk-Tunnel',
      'updates',
      installationId(executable),
    );
    this.installDirectory = fs.realpathSync(path.dirname(executable));
    this.lockName = lockName ?? `\\\\.\\pipe\\cc-managed-update-${installationId(executable)}`;
    fs.mkdirSync(this.directory, { recursive: true });
    // MSIX filesystem virtualization is not a junction. Resolve its physical location once,
    // after rejecting actual links in the application-owned path.
    for (const folder of [
      path.dirname(path.dirname(this.directory)),
      path.dirname(this.directory),
      this.directory,
    ])
      if (fs.lstatSync(folder).isSymbolicLink()) throw new Error('更新缓存不能是符号链接');
    this.directory = fs.realpathSync.native(this.directory);
    this.activity = null;
    this.startedAt = this.now();
    this.memberFile = path.join(this.directory, `instance-${process.pid}.json`);
    this.writeMember();
    this.observed = '';
  }
  file(name) {
    if (name === 'ledger.json') name = `ledger-${this.identity.channel}.json`;
    return path.join(this.directory, name);
  }
  state() {
    const value = read(this.file('state.json'), { phase: 'idle' });
    // A dead download owner cannot leave the interface permanently stuck.
    if (['checking', 'downloading', 'preparing'].includes(value.phase) && !alive(value.owner))
      return { ...value, phase: 'error', message: '上次更新已中断，可以重试。' };
    return { ...value, identity: this.identity, pending: read(this.file('pending.json')) };
  }
  publish(value) {
    atomic(this.file('state.json'), { ...value, owner: process.pid });
    this.notify(this.state());
  }
  writeMember() {
    atomic(this.memberFile, { pid: process.pid, at: this.now(), activity: this.activity });
  }
  report(activity) {
    if (!activity || typeof activity.blocked !== 'boolean')
      throw new Error('Invalid update activity');
    this.activity = { blocked: activity.blocked };
    this.reportedAt = this.now();
    this.writeMember();
  }
  poll() {
    const state = this.state();
    const text = JSON.stringify(state);
    if (text !== this.observed) {
      this.observed = text;
      this.notify(state);
    }
    if (
      state.phase === 'installing' &&
      state.owner !== process.pid &&
      !this.activity?.blocked &&
      this.now() - this.reportedAt < 5000
    )
      this.quit();
  }
  start(onError, automatic = true) {
    this.pollTimer = setInterval(() => {
      try {
        this.poll();
      } catch (error) {
        this.stop();
        onError(error);
      }
    }, 1000);
    this.pollTimer.unref();
    if (!automatic) return;
    this.startTimer = setTimeout(() => this.check(false).catch(() => {}), 30000);
    this.startTimer.unref();
    this.checkTimer = setInterval(() => this.check(false).catch(() => {}), 6 * 3600 * 1000);
    this.checkTimer.unref();
  }
  stop() {
    clearInterval(this.pollTimer);
    clearTimeout(this.startTimer);
    clearInterval(this.checkTimer);
    this.abort?.abort();
    fs.rmSync(this.memberFile, { force: true });
  }
  async locked(action) {
    if (this.active) throw new Error('更新操作正在进行');
    this.active = true;
    const server = net.createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.lockName, resolve);
      });
      this.abort = new AbortController();
      return await action(this.abort.signal);
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      this.active = false;
      this.abort = null;
    }
  }
  async operation(action) {
    return this.locked(async (signal) => {
      const started = this.now();
      const previous = this.state();
      fs.rmSync(this.file('cancel.json'), { force: true });
      const cancellationTimer = setInterval(() => {
        try {
          const cancellation = read(this.file('cancel.json'));
          if (cancellation?.owner === process.pid && cancellation.at >= started)
            this.abort?.abort();
        } catch (error) {
          this.abort?.abort(error);
        }
      }, 200);
      try {
        return await action(signal);
      } catch (error) {
        if (error.code !== 'UPDATE_THROTTLED')
          this.publish({
            ...(error.code === 'UPDATE_BUSY' ? previous : { phase: 'error' }),
            message: signal.aborted ? '更新已取消。' : error.message,
          });
        throw error;
      } finally {
        clearInterval(cancellationTimer);
      }
    });
  }
  cancel() {
    const state = this.state();
    if (state.phase === 'installing') throw new Error('安装器正在启动，请在安装器中取消');
    atomic(this.file('cancel.json'), { owner: state.owner, at: this.now() });
    this.abort?.abort();
    return this.state();
  }
  async loadIndex(signal) {
    const index = this.contract.verifyIndex(
      await this.network.index(this.identity.channel, signal),
      this.identity.trustedKeys,
      this.now(),
    );
    signal.throwIfAborted();
    const ledger = read(this.file('ledger.json'), {
      replay: null,
      confirmedBuild: this.identity.build,
    });
    const selected = this.contract.selectUpdate(
      index,
      { ...this.identity, build: Math.max(this.identity.build, ledger.confirmedBuild) },
      ledger.replay,
    );
    if (selected.status === 'scope-mismatch') throw new Error('更新通道不匹配');
    atomic(this.file('ledger.json'), { ...ledger, replay: selected.nextState });
    return selected;
  }
  async check(manual = true) {
    return this.operation(async (signal) => {
      const previous = this.state();
      if (['installing', 'preparing'].includes(previous.phase)) return previous;
      const last = read(this.file('last-check.json'), { at: 0 });
      if (this.now() - last.at < (manual ? 30000 : 6 * 3600 * 1000)) {
        if (manual)
          throw Object.assign(new Error('请间隔至少 30 秒再检查更新'), {
            code: 'UPDATE_THROTTLED',
          });
        return previous;
      }
      atomic(this.file('last-check.json'), { at: this.now() });
      this.publish({ phase: 'checking' });
      const selected = await this.loadIndex(signal);
      const ready = read(this.file('ready.json'));
      const alreadyReady =
        selected.status === 'available' &&
        ready?.build === selected.release.build &&
        ready?.sha256 === selected.release.sha256;
      this.publish({
        phase: alreadyReady ? 'ready' : selected.status === 'available' ? 'available' : 'idle',
        release: selected.release,
        message:
          selected.status === 'protocol-mismatch'
            ? '此更新需要管理员配套迁移服务端。'
            : selected.status === 'available'
              ? '有新的定制客户端可下载。'
              : '当前没有可用更新。',
      });
      return this.state();
    });
  }
  async download() {
    return this.operation(async (signal) => {
      const selected = await this.loadIndex(signal);
      if (selected.status !== 'available') throw new Error('当前没有兼容的更新');
      const release = selected.release;
      this.startedDownload = this.now();
      let progressAt = 0;
      const file = this.file(`download-${release.build}-${release.sha256}.part`);
      await this.safePath(file, false);
      this.publish({ phase: 'downloading', release, received: 0 });
      await this.network.download(
        this.identity.origin + this.contract.artifactPath(release),
        file,
        release,
        signal,
        (received) => {
          const cancellation = read(this.file('cancel.json'));
          if (cancellation?.owner === process.pid && cancellation.at >= this.startedDownload)
            this.abort.abort();
          if (this.now() - progressAt >= 250 || received === release.size) {
            progressAt = this.now();
            this.publish({ phase: 'downloading', release, received });
          }
        },
      );
      signal.throwIfAborted();
      const digest = await hashFile(file);
      if (digest.size !== release.size || digest.sha256 !== release.sha256) {
        await fsp.rm(file);
        throw new Error('安装包完整性校验失败');
      }
      await this.safePath(this.file('ready.exe'), false);
      await fsp.rename(file, this.file('ready.exe'));
      atomic(this.file('ready.json'), release);
      this.publish({
        phase: 'ready',
        release,
        received: release.size,
        message: '下载完成，断开所有远端连接后可以安装。',
      });
      return this.state();
    });
  }
  async safePath(file, required = true) {
    if (
      fs.realpathSync.native(this.directory).toLowerCase() !==
      path.resolve(this.directory).toLowerCase()
    )
      throw new Error('更新缓存路径发生变化');
    const found = await fsp.lstat(file).catch((error) => {
      if (!required && error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      found &&
      (!found.isFile() ||
        found.isSymbolicLink() ||
        (await fsp.realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase())
    )
      throw new Error('安装包路径不安全');
  }
  async assertReady(release, signal) {
    const selected = await this.loadIndex(signal);
    if (
      selected.status !== 'available' ||
      selected.release.build !== release.build ||
      selected.release.sha256 !== release.sha256 ||
      selected.release.size !== release.size
    )
      throw new Error('更新已撤回或改变，请重新检查');
    const file = this.file('ready.exe');
    await this.safePath(file);
    const digest = await hashFile(file);
    signal.throwIfAborted();
    if (digest.size !== release.size || digest.sha256 !== release.sha256)
      throw new Error('安装前完整性校验失败');
    return file;
  }
  async members() {
    const result = [];
    for (const name of fs
      .readdirSync(this.directory)
      .filter((name) => /^instance-\d+\.json$/.test(name))) {
      const member = read(this.file(name));
      if (!alive(member?.pid)) {
        fs.rmSync(this.file(name), { force: true });
        continue;
      }
      if (this.now() - member.at > 5000 || !member.activity || member.activity.blocked !== false)
        throw Object.assign(
          new Error('请先断开所有连接并结束任务、终端和登录流程；有窗口状态尚未确认。'),
          { code: 'UPDATE_BUSY' },
        );
      result.push(member.pid);
    }
    const actual = await this.processes();
    if (actual.some((pid) => !result.includes(pid)))
      throw Object.assign(new Error('发现尚未确认状态的客户端进程'), { code: 'UPDATE_BUSY' });
    return result;
  }
  async install() {
    return this.operation(async (signal) => {
      if (this.state().phase !== 'ready') throw new Error('请先下载并校验更新');
      const release = read(this.file('ready.json'));
      let file = await this.assertReady(release, signal);
      await this.members();
      this.publish({ phase: 'preparing', release, message: '正在协调所有连接窗口退出。' });
      // Give every process time to observe the freeze, then require a fresh activity report.
      await delay(1100, undefined, { signal });
      const members = await this.members();
      this.publish({ phase: 'installing', release });
      const deadline = this.now() + 15000;
      while (members.some((pid) => pid !== process.pid && alive(pid))) {
        if (this.now() >= deadline) throw new Error('其他窗口未能退出，已取消安装');
        await delay(100, undefined, { signal });
      }
      file = await this.assertReady(release, signal);
      const actual = await this.processes();
      if (actual.some((pid) => pid !== process.pid))
        throw new Error('仍有客户端窗口运行，已取消安装');
      const pending = {
        targetBuild: release.build,
        originalBuild: this.identity.build,
        sha256: release.sha256,
        at: this.now(),
        status: 'pending',
      };
      atomic(this.file('pending.json'), pending);
      const helperPid = await this.launchInstaller({
        file,
        directory: this.installDirectory,
        release,
        pending: this.file('pending.json'),
        parentPid: process.pid,
      });
      atomic(this.file('pending.json'), { ...pending, helperPid });
      this.quit();
      return this.state();
    });
  }
  async recover() {
    return this.locked(async () => {
      const ledger = read(this.file('ledger.json'), {
        replay: null,
        confirmedBuild: this.identity.build,
      });
      const pending = read(this.file('pending.json'));
      atomic(this.file('ledger.json'), {
        ...ledger,
        confirmedBuild: Math.max(ledger.confirmedBuild, this.identity.build),
      });
      if (pending && this.identity.build === pending.targetBuild) {
        atomic(this.file('ledger.json'), {
          ...ledger,
          confirmedBuild: Math.max(ledger.confirmedBuild, this.identity.build),
        });
        atomic(this.file('last-install.json'), {
          ...pending,
          status: 'confirmed',
          confirmedAt: this.now(),
        });
        fs.rmSync(this.file('pending.json'));
        fs.rmSync(this.file('ready.json'), { force: true });
        this.publish({ phase: 'idle', message: `定制构建 ${this.identity.build} 安装已确认。` });
      } else if (pending && alive(pending.helperPid)) {
        throw Object.assign(new Error('安装器仍在运行，请完成或取消安装后重新启动客户端。'), {
          code: 'UPDATE_INSTALL_ACTIVE',
        });
      } else {
        if (pending) atomic(this.file('pending.json'), { ...pending, status: 'unconfirmed' });
        const release = read(this.file('ready.json'));
        this.publish({
          phase: release ? 'ready' : 'idle',
          release,
          message: pending ? '上次安装尚未确认，可重试；诊断记录已保留。' : undefined,
        });
      }
    });
  }
}
module.exports = { ManagedController, hashFile, atomic, alive };
