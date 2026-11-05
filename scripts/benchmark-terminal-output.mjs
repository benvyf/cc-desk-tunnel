// Run with Node 24. An optional baseline module must use the same dependencies as the current source.
// This measures transport batching and real Linux PTY output, not GPU/pixel presentation.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeTerminal } from '../apps/server/src/native-terminal.ts';

const percentile = (values, fraction) => {
  const sorted = values.toSorted((a, b) => a - b);
  return Number(
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(3),
  );
};

async function fragmented(Terminal) {
  let receive, finish;
  const pending = [],
    frames = [],
    latencies = [],
    input = [];
  let length = 0,
    expected = '',
    consumed = 0;
  const terminal = new Terminal(
    'fixture',
    [],
    { cwd: '.', cols: 100, rows: 35, env: {} },
    (text, bytes) => {
      frames.push(text);
      assert.equal(bytes, Buffer.byteLength(text));
      length += text.length;
      const now = performance.now();
      while (consumed < pending.length && pending[consumed].end <= length)
        latencies.push(now - pending[consumed++].at);
    },
    () => {},
    () => ({
      pid: 2147483647,
      onData(fn) {
        receive = fn;
      },
      onExit(fn) {
        finish = fn;
      },
      write(text) {
        input.push(text);
      },
      resize() {},
      pause() {},
      resume() {},
      kill() {
        queueMicrotask(() => finish({ exitCode: 0 }));
      },
    }),
  );
  const started = performance.now();
  try {
    for (let burst = 0; burst < 40; burst++) {
      for (let piece = 0; piece < 20; piece++) {
        const text = `\x1b[2K\r输出🙂 ${burst}:${piece}`;
        expected += text;
        pending.push({ at: performance.now(), end: expected.length });
        receive(text);
      }
      terminal.write('input');
      await delay(8);
      terminal.acknowledge(terminal.outstanding);
    }
    await delay(15);
    assert.equal(frames.join(''), expected);
    assert.equal(consumed, pending.length);
    assert.equal(input.length, 40);
    return {
      writes: pending.length,
      frames: frames.length,
      bytes: Buffer.byteLength(expected),
      deliveryMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
      elapsedMs: Number((performance.now() - started).toFixed(2)),
    };
  } finally {
    await terminal.close();
  }
}

async function realPty(Terminal) {
  if (process.platform !== 'linux')
    return { skipped: 'requires Linux for the remote PTY comparison' };
  const frames = [];
  const program = `let i=0;function tick(){for(let j=0;j<20;j++)process.stdout.write('\\x1b[2K\\rPTY '+i+':'+j+' 中文🙂');if(++i<40)setTimeout(tick,8);else process.stdout.write('\\r\\nFINAL_PTY_TAIL\\r\\n');}tick();`;
  const started = performance.now();
  const terminal = new Terminal(
    process.execPath,
    ['-e', program],
    {
      cwd: process.cwd(),
      cols: 100,
      rows: 35,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    },
    (text, bytes) => {
      assert.equal(bytes, Buffer.byteLength(text));
      frames.push(text);
    },
    () => {},
  );
  const timeout = setTimeout(() => void terminal.close(), 10000);
  try {
    await terminal.closed;
    const output = frames.join('');
    assert.equal(terminal.reason, 'process_exit', 'PTY must exit normally');
    assert.ok(output.includes('FINAL_PTY_TAIL'));
    let previous = -1;
    for (let burst = 0; burst < 40; burst++)
      for (let piece = 0; piece < 20; piece++) {
        const index = output.indexOf(`PTY ${burst}:${piece} 中文🙂`, previous + 1);
        assert.ok(index > previous, `missing/reordered PTY write ${burst}:${piece}`);
        previous = index;
      }
    return {
      frames: frames.length,
      bytes: Buffer.byteLength(output),
      elapsedMs: Number((performance.now() - started).toFixed(2)),
      tailIntact: true,
    };
  } finally {
    clearTimeout(timeout);
    await terminal.close();
  }
}

const versions = [];
if (process.argv[2])
  versions.push([
    'baseline',
    (await import(pathToFileURL(resolve(process.argv[2])).href)).NativeTerminal,
  ]);
versions.push(['current', NativeTerminal]);
const results = { node: process.version, platform: process.platform, measurements: {} };
for (const [name, Terminal] of versions)
  results.measurements[name] = {
    fragmented: await fragmented(Terminal),
    realPty: await realPty(Terminal),
  };
console.log(JSON.stringify(results, null, 2));
