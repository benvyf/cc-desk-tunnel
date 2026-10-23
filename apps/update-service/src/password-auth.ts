import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chown, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UpdateError } from './store.ts';

type Credentials = {
  password?: { salt: string; hash: string };
  setup?: { hash: string; expiresAt: number };
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sessionLifetime = 8 * 3600000;
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export class PasswordAuth {
  private directory: string;
  private sessions = new Map<string, number>();
  private busy = false;
  constructor(privateDirectory: string) {
    this.directory = privateDirectory;
  }
  private async read(): Promise<Credentials> {
    try {
      return JSON.parse(await readFile(join(this.directory, 'admin-login.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
  private async write(value: Credentials) {
    const path = join(this.directory, 'admin-login.json');
    const temporary = path + '.' + randomBytes(8).toString('hex') + '.part';
    try {
      await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
      // The root-only setup CLI must leave this file owned by the running service.
      if (process.platform !== 'win32') {
        const owner = await stat(this.directory);
        await chown(temporary, owner.uid, owner.gid);
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  // Called only by the SSH CLI, never exposed as a public HTTP operation.
  async issueSetup(): Promise<string> {
    const current = await this.read();
    const token = randomBytes(32).toString('base64url');
    await this.write({
      ...current,
      setup: { hash: digest(token), expiresAt: Date.now() + 600000 },
    });
    return token;
  }
  private session() {
    for (const [key, expiry] of this.sessions) if (expiry <= Date.now()) this.sessions.delete(key);
    if (this.sessions.size >= 16) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(digest(token), Date.now() + sessionLifetime);
    return token;
  }
  accepts(token: string, now = Date.now()) {
    const key = digest(token);
    const expiry = this.sessions.get(key);
    if (expiry === undefined) return false;
    if (expiry <= now) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }
  logout(token: string) {
    this.sessions.delete(digest(token));
  }
  private async exclusive<T>(work: () => Promise<T>) {
    if (this.busy) throw new UpdateError(429, '登录验证繁忙，请稍后重试。');
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  async login(password: unknown): Promise<string | undefined> {
    return this.exclusive(async () => {
      const current = await this.read();
      if (!current.password)
        throw new UpdateError(409, '尚未设置管理员密码，请先通过 SSH 打开密码设置页面。');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128)
        return undefined;
      const actual = await derive(password, current.password.salt);
      const expected = Buffer.from(current.password.hash, 'hex');
      return timingSafeEqual(actual, expected) ? this.session() : undefined;
    });
  }
  async setup(token: unknown, password: unknown): Promise<string> {
    return this.exclusive(async () => {
      if (typeof password !== 'string' || password.length < 8 || password.length > 128)
        throw new UpdateError(400, '密码需要 8–128 个字符，可包含中文；不要填写管理令牌。');
      const current = await this.read();
      const valid = (value: Credentials) =>
        typeof token === 'string' &&
        /^[A-Za-z0-9_-]{32,128}$/.test(token) &&
        value.setup &&
        value.setup.expiresAt > Date.now() &&
        timingSafeEqual(Buffer.from(value.setup.hash, 'hex'), Buffer.from(digest(token), 'hex'));
      if (!valid(current))
        throw new UpdateError(401, '设置链接已过期或无效，请重新通过 SSH 打开设置页面。');
      const salt = randomBytes(16).toString('hex');
      const hash = (await derive(password, salt)).toString('hex');
      if (!valid(await this.read()))
        throw new UpdateError(401, '设置链接已过期或已更换，请重新打开设置页面。');
      // Consume the one-use setup token in the same atomic replacement as the password.
      await this.write({ password: { salt, hash } });
      this.sessions.clear();
      return this.session();
    });
  }
  async changePassword(
    currentPassword: unknown,
    newPassword: unknown,
  ): Promise<string | undefined> {
    return this.exclusive(async () => {
      if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128)
        throw new UpdateError(400, '新密码需要 8–128 个字符，可包含中文。');
      const current = await this.read();
      if (!current.password)
        throw new UpdateError(409, '尚未设置管理员密码，请先通过 SSH 打开密码设置页面。');
      if (
        typeof currentPassword !== 'string' ||
        currentPassword.length < 8 ||
        currentPassword.length > 128
      )
        return undefined;
      const actual = await derive(currentPassword, current.password.salt);
      if (!timingSafeEqual(actual, Buffer.from(current.password.hash, 'hex'))) return undefined;
      const salt = randomBytes(16).toString('hex');
      const hash = (await derive(newPassword, salt)).toString('hex');
      await this.write({ password: { salt, hash } });
      this.sessions.clear();
      return this.session();
    });
  }
}
