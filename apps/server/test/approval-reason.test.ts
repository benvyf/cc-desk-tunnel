import assert from 'node:assert/strict';
import test from 'node:test';
import { eventPayloadSchema } from '@cc-desk-tunnel/protocol';
import { asked } from '../src/claude.ts';

// Why Claude Code asks about a call goes to the client with the approval (upstream 85785f72, 4053b1a0).
test('a safety check is told by its kind, and every ask is one while bypassing permissions', () => {
  const safety = {
    decisionReason: '  Dangerous rm operation  ',
    decisionReasonType: 'safetyCheck',
  };
  assert.deepEqual(asked(safety, 'auto'), {
    reason: 'Dangerous rm operation',
    safetyCheck: true,
  });
  // A compound command's ask comes as its subcommands' results; bypassing, it is still a safety check.
  assert.deepEqual(
    asked(
      { decisionReason: 'cd && rm', decisionReasonType: 'subcommandResults' } as never,
      'bypassPermissions',
    ),
    {
      reason: 'cd && rm',
      safetyCheck: true,
    },
  );
  assert.deepEqual(asked({ decisionReason: 'Bash(npm test)' }, 'default'), {
    reason: 'Bash(npm test)',
  });
  assert.deepEqual(asked({}, 'default'), {});
  // The user's own ask rule or hook is not a safety check, bypassing or not.
  for (const kind of ['rule', 'hook'])
    assert.deepEqual(
      asked(
        { decisionReason: 'Bash(rm:*)', decisionReasonType: kind } as never,
        'bypassPermissions',
      ),
      { reason: 'Bash(rm:*)' },
    );
  // The CLI not in bypass after all (as it reported) tells nothing more than the kind.
  assert.deepEqual(asked({ decisionReason: 'x' }, 'default'), { reason: 'x' });
  assert.equal(asked({ decisionReason: 'x'.repeat(5000) }, 'default').reason?.length, 4000);
});

test('the reason travels as optional fields of approval.requested, which older events lack', () => {
  const base = { type: 'approval.requested', approvalId: crypto.randomUUID(), toolId: 't1' };
  assert.deepEqual(eventPayloadSchema.parse(base), base);
  const told = { ...base, reason: 'why', safetyCheck: true };
  assert.deepEqual(eventPayloadSchema.parse(told), told);
  assert.throws(() => eventPayloadSchema.parse({ ...base, reason: 'x'.repeat(4001) }));
});
