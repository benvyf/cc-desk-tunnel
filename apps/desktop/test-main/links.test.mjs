import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkDoubt, linkTarget, localPicture } from '../src/links.ts';
import { pictureNote, toolPictures } from '../src/pictures.ts';

const windows = { projectPath: 'C:\\Work\\App', here: true, browser: false };
const mac = { projectPath: '/Users/me/app', here: true, browser: false };

test('web addresses open anywhere, other schemes not at all', () => {
  assert.deepEqual(linkTarget('https://example.com/a?b=1', null), {
    kind: 'web',
    url: 'https://example.com/a?b=1',
  });
  assert.equal(linkTarget('mailto:a@b.c', windows).kind, 'web');
  assert.equal(linkTarget('javascript:alert(1)', windows), null);
  assert.equal(linkTarget('ms-msdt:/id', windows), null);
  assert.equal(linkTarget('#section', windows), null);
  // Without a session there is no folder for a path to be in.
  assert.equal(linkTarget('src/a.ts', null), null);
});

test('paths are read as Markdown passed them on, with a line and column at the end', () => {
  // The Markdown parser percent-encodes backslashes, spaces and other letters.
  assert.deepEqual(linkTarget('C:%5Ca%20b%5C%E4%B8%AD%E6%96%87.md', windows), {
    kind: 'path',
    path: 'C:\\a b\\中文.md',
    line: undefined,
    column: undefined,
  });
  assert.deepEqual(linkTarget('C:/x/y.ts:12:3', windows), {
    kind: 'path',
    path: 'C:\\x\\y.ts',
    line: 12,
    column: 3,
  });
  assert.deepEqual(linkTarget('src/a.ts#L12-L20', windows), {
    kind: 'path',
    path: 'C:\\Work\\App\\src\\a.ts',
    line: 12,
    column: undefined,
  });
  assert.equal(linkTarget('./docs/../README.md', windows).path, 'C:\\Work\\App\\README.md');
  assert.equal(linkTarget('file:///C:/a%20b/x.png', windows).path, 'C:\\a b\\x.png');
  assert.equal(linkTarget('../other/x.md', mac).path, '/Users/me/other/x.md');
  assert.equal(linkTarget('file:///Users/me/a%20b.md', mac).path, '/Users/me/a b.md');
  assert.equal(linkTarget('/Users/me/app/src/', mac).path, '/Users/me/app/src/');
  assert.deepEqual(linkTarget('lib/b.py:7', mac), {
    kind: 'path',
    path: '/Users/me/app/lib/b.py',
    line: 7,
    column: undefined,
  });
});

test('a path this window cannot open says why', () => {
  // On a Windows project, a POSIX path is one on the service.
  assert.match(linkTarget('/data/state/x.txt', windows).reason, /服务端/);
  assert.match(linkTarget('C:%5Cx', mac).reason, /Windows/);
  assert.match(linkTarget('file://server/share/a.txt', windows).reason, /网络共享/);
  assert.match(linkTarget('~/notes.md', windows).reason, /不完整/);
  assert.match(linkTarget('src/a.ts', { ...windows, here: false }).reason, /另一台电脑/);
  assert.match(linkTarget('src/a.ts', { ...windows, here: false, browser: true }).reason, /浏览器/);
  // On a Mac, whether a POSIX path is the service's is for the desktop to find out.
  assert.equal(linkTarget('/data/state/x.txt', mac).kind, 'path');
});

test('a picture on this computer has an address of its own', () => {
  assert.equal(localPicture('C:\\a b\\x.png'), 'local-image://file/C%3A%5Ca%20b%5Cx.png');
});

test('pictures a tool looked at are taken out of its output', () => {
  const data = 'iVBORw0KGgo=';
  const output = JSON.stringify([
    { type: 'text', text: 'Read 1 image' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ]);
  assert.deepEqual(toolPictures(output), {
    text: 'Read 1 image',
    pictures: [{ type: 'image/png', data }],
  });
  assert.equal(pictureNote({ type: 'image/png', data }), '[图片 image/png · 1 KB]');
  // Anything else is output as it is.
  assert.equal(toolPictures('["image"]'), null);
  assert.equal(toolPictures('plain "image" text'), null);
  assert.equal(
    toolPictures(JSON.stringify([{ type: 'image', source: { type: 'url', url: 'https://x' } }])),
    null,
  );
});

test('a web link asks first only when its text or address may mislead', () => {
  // Words, a file name or the same site: opened at once, the card shows where.
  assert.equal(linkDoubt('官方文档', 'https://docs.example.com/a'), null);
  assert.equal(linkDoubt('README.md', 'https://github.com/o/r/blob/main/README.md'), null);
  assert.equal(linkDoubt('main.rs', 'https://github.com/o/r/blob/main/src/main.rs'), null);
  assert.equal(linkDoubt('README.md#usage', 'https://github.com/o/r#usage'), null);
  assert.equal(linkDoubt('https://example.com', 'https://example.com/'), null);
  assert.equal(linkDoubt('www.Example.com', 'https://example.com/x'), null);
  assert.equal(linkDoubt('example.com/docs。', 'https://www.example.com/docs'), null);
  assert.equal(linkDoubt('a@b.c', 'mailto:a@b.c'), null);
  assert.equal(linkDoubt('main.cc', 'https://github.com/o/r/blob/main/src/main.cc'), null);
  assert.equal(linkDoubt('README.org', 'https://github.com/o/r/blob/main/README.org'), null);
  assert.equal(linkDoubt('ASP.NET', 'https://dotnet.microsoft.com/apps/aspnet'), null);
  assert.equal(linkDoubt('Socket.IO 文档', 'https://socket.io/docs/'), null);
  assert.equal(linkDoubt('localhost:3000', 'http://localhost:3000/'), null);
  assert.equal(linkDoubt('v2.0.1', 'https://github.com/o/r/releases/tag/v2.0.1'), null);
  assert.equal(linkDoubt('@types/node', 'https://www.npmjs.com/package/@types/node'), null);
  assert.equal(linkDoubt('在 example.com 查看', 'https://example.com/x'), null);
  assert.equal(linkDoubt('访问example.com', 'https://example.com/x'), null);
  assert.equal(linkDoubt('详见docs.rs/serde', 'https://docs.rs/serde'), null);
  assert.equal(linkDoubt('console.info()', 'https://developer.mozilla.org/x'), null);
  assert.equal(linkDoubt('window.top', 'https://developer.mozilla.org/x'), null);
  assert.equal(linkDoubt('main.cc 第 12 行', 'https://github.com/o/r/blob/main/main.cc'), null);
  assert.equal(linkDoubt('从 github.com 迁移到 gitlab.com', 'https://gitlab.com/'), null);
  assert.equal(linkDoubt('https://example.com、https://b.com', 'https://example.com/'), null);
  assert.equal(linkDoubt('《https://example.com》', 'https://example.com/'), null);
  assert.equal(linkDoubt('https://example.com”', 'https://example.com/'), null);
  assert.equal(linkDoubt('https://example.com：说明', 'https://example.com/'), null);
  for (const text of [
    '(https://example.com)',
    'https://example.com,',
    'https://example.com; 说明',
    "'https://example.com'",
    'https://example.com.',
    'https://example.com!',
    'https://example.com: 说明',
  ])
    assert.equal(linkDoubt(text, 'https://example.com/'), null, text);
  assert.equal(linkDoubt('java.net', 'https://docs.oracle.com/javase/net.html'), null);
  assert.equal(linkDoubt('192.168.1.1:8080', 'http://192.168.1.1:8080/'), null);
  // Text that reads as another address than the one it leads to.
  assert.ok(linkDoubt('https://bank.com/login', 'https://evil.example/login'));
  assert.ok(linkDoubt('bank.com', 'https://evil.example/'));
  assert.ok(linkDoubt('www.bank.cn', 'https://bank.cn.evil.example/'));
  assert.ok(linkDoubt('docs.rs/serde', 'https://evil.example/serde'));
  // Words around it, wrapping marks or hidden characters do not hide the address.
  assert.ok(linkDoubt('bank.com 登录', 'https://evil.example/'));
  assert.ok(linkDoubt('(bank.com)', 'https://evil.example/'));
  assert.ok(linkDoubt('`bank.com`', 'https://evil.example/'));
  assert.ok(linkDoubt('「bank.com」', 'https://evil.example/'));
  assert.ok(linkDoubt('bank.com?x=1', 'https://evil.example/'));
  assert.ok(linkDoubt('bank.com登录', 'https://evil.example/'));
  assert.ok(linkDoubt('BANK.COM', 'https://evil.example/'));
  assert.ok(linkDoubt('paypal.COM/login', 'https://evil.example/'));
  assert.ok(linkDoubt('bank‮.com', 'https://evil.example/'), 'a bidirectional mark');
  assert.ok(linkDoubt('//bank.com', 'https://evil.example/'));
  // Nothing after an address's host is read as a site of its own, and a user name before it is a trick.
  assert.ok(linkDoubt('https://bank.com/login?u=evil.com', 'https://evil.com/'));
  assert.ok(linkDoubt('https://bank.com/#evil.com', 'https://evil.com/'));
  assert.ok(linkDoubt('http://bank.com:80@evil.com/', 'https://evil.com/'));
  assert.ok(linkDoubt('http://192.168.1.1', 'http://192.168.1.2/'));
  // A path the other site chose does not make its text a file name.
  assert.ok(linkDoubt('bank.com', 'https://evil.example/bank.com'));
  assert.ok(linkDoubt('paypal.com', 'https://evil.example/x/paypal.com'));
  assert.ok(linkDoubt('bank​.com', 'https://evil.example/'));
  // An address that hides where it goes.
  assert.ok(linkDoubt('看这里', 'https://bank.com@evil.example/'));
  assert.ok(linkDoubt('apple.com', new URL('https://аpple.com/').href), 'Cyrillic а');
  assert.ok(linkDoubt('下载', 'https://xn--80ak6aa92e.com/'));
});

test('a file name in the text passes only on a repository site; subdomains are one site; other schemes name none', () => {
  // Elsewhere the path is the other site's to choose.
  assert.ok(linkDoubt('claude.ai', 'https://evil.example/claude.ai'));
  assert.ok(linkDoubt('numpy.org', 'https://evil.example/x/numpy.org'));
  assert.equal(linkDoubt('main.cc', 'https://github.com/o/r/blob/main/main.cc'), null);
  assert.equal(linkDoubt('README.org', 'https://gitlab.com/o/r/-/blob/main/README.org'), null);
  // A host spelled in other letters names a site that never opens without asking.
  assert.ok(linkDoubt('https://银行.com', 'https://evil.example/'));
  // A name under the named site may be anyone's.
  assert.ok(linkDoubt('google.com', 'https://sites.google.com/view/evil'));
  assert.ok(linkDoubt('amazonaws.com', 'https://evil.s3.amazonaws.com/'));
  assert.equal(linkDoubt('google.com', 'https://m.google.com/'), null);
  assert.equal(linkDoubt('google.com', 'https://www.google.com/'), null);
  // The sentence going on after an address is not its host.
  assert.equal(linkDoubt('https://example.com查看详情', 'https://example.com/'), null);
  assert.equal(linkDoubt('访问https://example.com即可', 'https://example.com/'), null);
  assert.ok(linkDoubt('s3://bank.com/key', 'https://evil.example/'));
  // Letters going on to a dot are a host, and m. under a shared ending is someone else's site.
  assert.ok(linkDoubt('https://a.cn工商银行.com/login', 'https://a.cn/'));
  assert.ok(linkDoubt('https://evil.cn。paypal.com/', 'https://evil.cn/'));
  for (const shared of ['github.io', 'pages.dev', 'co.uk'])
    assert.ok(linkDoubt(shared, `https://m.${shared}/`), shared);
  assert.equal(linkDoubt('mail.google.com', 'https://google.com/'), null);
  assert.equal(linkDoubt('example.com', 'https://example.com./'), null);
  // A shared ending is not the site of everyone under it.
  assert.ok(linkDoubt('github.io', 'https://attacker.github.io/'));
  assert.ok(linkDoubt('bank.com', 'https://bank.com.evil.io/'));
  for (const text of ['s3://bucket/key', 'ssh://git@host', 'C://x', 'System.IO'])
    assert.equal(linkDoubt(text, 'https://example.com/'), null, text);
});
