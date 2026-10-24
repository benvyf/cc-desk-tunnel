import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSessionDefaults, sessionDefaultOptions } from '../src/modelDefaults.ts';

test('new session defaults validate persisted choices without losing independent fields', () => {
  assert.deepEqual(readSessionDefaults(undefined), { model: null, effort: null });
  assert.deepEqual(readSessionDefaults({ model: 'opus', effort: 'xhigh' }), {
    model: 'opus',
    effort: 'xhigh',
  });
  assert.deepEqual(readSessionDefaults({ model: 9, effort: 'high' }), {
    model: null,
    effort: 'high',
  });
  assert.deepEqual(readSessionDefaults({ model: 'opus', effort: 'unknown' }), {
    model: 'opus',
    effort: null,
  });
  assert.deepEqual(readSessionDefaults({ model: ' '.repeat(5), effort: null }), {
    model: null,
    effort: null,
  });
});

test('session defaults honor known model support and retain explicit choices before discovery', () => {
  const model = (value, supportedEffortLevels) => ({
    value,
    displayName: value,
    description: '',
    source: 'native',
    supportedEffortLevels,
  });
  const models = [
    model('default', ['low', 'medium', 'high']),
    model('opus', ['low', 'medium', 'high', 'xhigh', 'max']),
    model('haiku', []),
  ];
  assert.deepEqual(sessionDefaultOptions({ model: 'opus', effort: 'max' }, models), {
    model: 'opus',
    effort: 'max',
  });
  assert.deepEqual(sessionDefaultOptions({ model: 'haiku', effort: 'max' }, models), {
    model: 'haiku',
    effort: null,
  });
  assert.deepEqual(sessionDefaultOptions({ model: 'missing', effort: 'max' }, models), {
    model: null,
    effort: null,
  });
  assert.deepEqual(sessionDefaultOptions({ model: null, effort: 'high' }, models), {
    model: null,
    effort: 'high',
  });
  assert.deepEqual(sessionDefaultOptions({ model: 'opus', effort: 'max' }, undefined), {
    model: 'opus',
    effort: 'max',
  });
});
