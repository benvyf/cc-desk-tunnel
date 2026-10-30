import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { isTrustedRenderer } = createRequire(import.meta.url)('../electron/renderer-origin.cjs');
const entry = resolve('apps/desktop/dist/index.html');
function fixture() {
  const frame = { url: pathToFileURL(entry).href };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  return { frame, contents, event: { sender: contents, senderFrame: frame } };
}
test('only the owning primary renderer main frame at the application entry is trusted', () => {
  const f = fixture();
  assert(isTrustedRenderer(f.event, f.contents, entry));
  assert(!isTrustedRenderer(f.event, null, entry));
  assert(!isTrustedRenderer({ ...f.event, sender: { ...f.contents } }, f.contents, entry));
  assert(!isTrustedRenderer({ ...f.event, senderFrame: { ...f.frame } }, f.contents, entry));
  assert(!isTrustedRenderer({ ...f.event, senderFrame: null }, f.contents, entry));
});
test('other local files, lookalike filenames, website frames and destroyed renderers fail closed', () => {
  const f = fixture();
  for (const url of [
    pathToFileURL(resolve('unrelated.html')).href,
    pathToFileURL(entry + '.extra').href,
    'http://localhost:3000/',
    'about:blank',
    'invalid',
  ]) {
    f.frame.url = url;
    assert(!isTrustedRenderer(f.event, f.contents, entry), url);
  }
  f.frame.url = pathToFileURL(entry).href;
  f.contents.isDestroyed = () => true;
  assert(!isTrustedRenderer(f.event, f.contents, entry));
  assert(!isTrustedRenderer(undefined, f.contents, entry));
});
