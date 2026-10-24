import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelName } from '../src/modelName.ts';

test('short native family names include the resolved version without changing the model value', () => {
  const model = { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5' };
  assert.equal(modelName(model), 'Opus 5.5');
  assert.equal(model.value, 'opus');
  assert.equal(
    modelName({
      value: 'opus[1m]',
      displayName: 'Opus (1M context)',
      resolvedModel: 'claude-opus-5-5[1m]',
    }),
    'Opus 5.5 (1M context)',
  );
  assert.equal(
    modelName({ value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-4-6' }),
    'Sonnet 4.6',
  );
  assert.equal(
    modelName({ value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-3-5-haiku-20241022' }),
    'Haiku 3.5',
  );
  assert.equal(
    modelName({ value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-4-20250514' }),
    'Opus 4',
  );
});

test('complete and custom labels are preserved; default and raw model IDs can display their version', () => {
  assert.equal(
    modelName({
      value: 'opus',
      displayName: 'Opus 5.5 (1M context)',
      resolvedModel: 'claude-opus-5-5',
    }),
    'Opus 5.5 (1M context)',
  );
  assert.equal(
    modelName({ value: 'custom', displayName: '工作模型', resolvedModel: 'claude-opus-5-5' }),
    '工作模型',
  );
  assert.equal(
    modelName({ value: 'default', displayName: '默认模型' }, 'claude-opus-5-5'),
    'Opus 5.5',
  );
  assert.equal(modelName(undefined, 'claude-sonnet-4-6'), 'Sonnet 4.6');
  assert.equal(modelName({ value: 'opus', displayName: 'Opus' }, 'claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName(undefined, 'provider/model-v2'), 'provider/model-v2');
  assert.equal(modelName({ value: 'opus', displayName: 'Opus' }, 'claude-sonnet-4-6'), 'Opus');
  assert.equal(modelName(undefined), '原生默认');
});
