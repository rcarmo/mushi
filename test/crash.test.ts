import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from '@earendil-works/chord/context';
import { openCrashFixture } from './crash-fixture.ts';

test('SIGKILL recovers a committed unsafe tool intent without replaying its effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-crash-'));
  const child = Bun.spawn([process.execPath, 'test/crash-fixture.ts', directory], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    let output = '';
    const deadline = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    try {
      while (!output.includes('effect-started')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Crash fixture failed: ' + await new Response(child.stderr).text());
        output += new TextDecoder().decode(value);
      }
    } finally { clearTimeout(deadline); reader.releaseLock(); }
    child.kill('SIGKILL'); await child.exited;
    const { harness, root } = await openCrashFixture(directory, false);
    try {
      harness.resume();
      const submission = await root.submit({ type: 'input', content: 'Do one effect', requestId: 'hard-crash' }, ctx);
      expect((await submission.wait(withAbortSignal(AbortSignal.timeout(5000), ctx))).status).toBe('done');
      expect(await readFile(join(directory, 'effects.txt'), 'utf8')).toBe('effect\n');
      const history = await root.context(ctx);
      expect(JSON.stringify(history.entries)).toContain('interrupted');
      expect(JSON.stringify(history.entries)).toContain('Recovered without replay');
      expect(history.entries.filter(e => e.kind === 'pi.user')).toHaveLength(1);
    } finally { await harness.close(ctx); }
  } finally { child.kill(); await child.exited; await rm(directory, { recursive: true, force: true }); }
}, 10000);
