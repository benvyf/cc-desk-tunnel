import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import type { SessionEvent } from '@cc-desk-tunnel/protocol';
import { ProxyClient } from '../src/client.ts';
import { conversation, transcript } from '../src/transcript.ts';

// No socket, renderer or model: measures the real client's bulk fragment merging and transcript assembly
// separately. Browser responsiveness is covered by conversation-performance.spec.ts's paced stream.
for (const fragments of [4096, 16384]) {
  for (const kind of ['text.delta', 'thinking.delta'] as const) {
    test(`256 KiB ${kind} in ${fragments} fragments preserves exact content`, () => {
      const length = 256 * 1024;
      const text =
        kind === 'thinking.delta'
          ? ' '.repeat(length / 2) + 'thinking\n'.repeat(length / 16).slice(0, length / 2)
          : 'answer 01234567\n'.repeat(length / 8).slice(0, length);
      assert.equal(Buffer.byteLength(text), length);
      const samples: { mergeMs: number; assembleMs: number; recordedAssembleMs: number }[] = [];
      for (let sample = -1; sample < 5; sample++) {
        const client = new ProxyClient();
        const sessionId = 'performance-session',
          runId = 'performance-run',
          messageId = 'performance-message';
        const event = (payload: SessionEvent['payload'], sequence: number): SessionEvent => ({
          sessionId,
          runId,
          sequence,
          createdAt: '2026-10-31T00:00:00.000Z',
          payload,
        });
        client.streamEvents = [
          event(
            { type: 'message.user', messageId: 'question', text: 'measure', scenario: 'chat' },
            1,
          ),
        ];
        client.select(sessionId);
        client.streamEvents = Array.from({ length: fragments }, (_, n) => ({
          type: 'session.fragment' as const,
          sessionId,
          runId,
          payload: {
            type: kind,
            messageId,
            text: text.slice((n * length) / fragments, ((n + 1) * length) / fragments),
          },
        }));
        const start = performance.now();
        client.select(sessionId); // Public operation flushes the pending fragment batch.
        const merged = performance.now();
        const shown = client.shown(sessionId);
        conversation(shown);
        const assembled = performance.now();
        assert.equal(
          transcript(shown)
            .filter((item) => 'text' in item)
            .find((item) => item.kind === 'assistant' || item.kind === 'thinking')?.text,
          text,
        );
        client.streamEvents = [
          event({ type: kind, messageId, text }, 2),
          event(
            { type: 'run.status', status: 'completed', connectionId: 'performance-connection' },
            3,
          ),
        ];
        client.select(sessionId);
        const recordedStart = performance.now();
        const turns = conversation(client.shown(sessionId));
        const recordedEnd = performance.now();
        assert.equal(
          transcript(client.shown(sessionId))
            .filter((item) => 'text' in item)
            .find((item) => item.kind === 'assistant' || item.kind === 'thinking')?.text,
          text,
        );
        assert.equal(turns.length, 1);
        if (kind === 'text.delta') assert.equal(turns[0].answer?.text, text);
        assert.equal(client.state.live[sessionId], undefined);
        if (sample >= 0)
          samples.push({
            mergeMs: merged - start,
            assembleMs: assembled - merged,
            recordedAssembleMs: recordedEnd - recordedStart,
          });
      }
      console.log(
        JSON.stringify({
          workload: 'fragment-processing',
          node: process.version,
          platform: process.platform,
          fragments,
          kind,
          bytes: length,
          warmups: 1,
          samples,
        }),
      );
    });
  }
}
