import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syntaxMarkup } from '../src/syntax.ts';

test('code syntax identifies common languages while escaping authored markup', () => {
  const source = 'const name = "<img src=x onerror=alert(1)>"; // comment';
  const markup = syntaxMarkup(source, 'ts');
  assert.match(markup, /hljs-keyword/);
  assert.match(markup, /hljs-string/);
  assert.match(markup, /hljs-comment/);
  assert(!markup.includes('<img'));
  assert.match(syntaxMarkup('{"ok": true}', 'json'), /hljs-attr/);
  assert.match(syntaxMarkup('def greet():\n  return "你好"', 'py'), /hljs-keyword/);
  assert.match(syntaxMarkup('function Test-Preview { return "你好" }', 'ps1'), /hljs-keyword/);
});
test('unknown languages and large sources remain plain without auto-detection', () => {
  assert.equal(syntaxMarkup('some plain text', 'unknown'), '');
  assert.equal(syntaxMarkup('x'.repeat(100001), 'js'), '');
});
