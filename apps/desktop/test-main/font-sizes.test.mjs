import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFontSizes } from '../src/fontSizes.ts';

test('font sizes preserve independent valid choices and reject unsafe persisted values', () => {
  assert.deepEqual(readFontSizes(undefined), { interface: 14, code: 13 });
  assert.deepEqual(readFontSizes({ interface: 18, code: 16 }), { interface: 18, code: 16 });
  for (const invalid of [null, '18', 0, -1, 999, NaN, Infinity, 14.5]) {
    assert.deepEqual(readFontSizes({ interface: invalid, code: 16 }), {
      interface: 14,
      code: 16,
    });
    assert.deepEqual(readFontSizes({ interface: 18, code: invalid }), {
      interface: 18,
      code: 13,
    });
  }
  assert.deepEqual(readFontSizes({ interface: 12, code: 10 }), { interface: 12, code: 10 });
  assert.deepEqual(readFontSizes({ interface: 20, code: 24 }), { interface: 20, code: 24 });
});
