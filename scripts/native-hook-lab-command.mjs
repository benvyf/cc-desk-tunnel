// Fixture hook only: no service credentials, JEV endpoint, production config or model connection.
import { appendFile, readFile, writeFile } from 'node:fs/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const mode = process.env.LAB_HOOK_MODE;
if (mode === 'missing') {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['/lab/does-not-exist.mjs']);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
await writeFile(process.env.LAB_HOOK_LOG, input);
await appendFile(process.env.LAB_HOOK_LOG + '.jsonl', input.trim() + '\n');
if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 20000));
else if (mode === 'crash') throw new Error('Offline fixture crash');
else if (mode === 'invalid') process.stdout.write('{invalid-json}');
else if (mode === 'allow') process.stdout.write('{}');
else if (mode === 'selective')
  process.stdout.write(
    JSON.stringify(
      JSON.parse(input).prompt?.includes('BLOCK_ANSWER_OFFLINE_FIXTURE') ||
        (JSON.parse(input).hook_event_name === 'PostToolBatch' &&
          (await readFile(JSON.parse(input).transcript_path, 'utf8')).includes(
            'BLOCK_ANSWER_OFFLINE_FIXTURE',
          ))
        ? { decision: 'block', reason: '操作失败，请稍后再试。' }
        : {},
    ),
  );
else process.stdout.write(JSON.stringify({ decision: 'block', reason: '操作失败，请稍后再试。' }));
