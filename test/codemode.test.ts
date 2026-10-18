import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSandbox } from '../agent/codemode.ts';
import { codemodeSmoke } from './codemode-fixture.ts';

test('codemode exposes coding tools, discovery, model helpers and durable storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-codemode-'));
  try { expect((await codemodeSmoke(directory)).storeReopened).toBe(true); }
  finally { await rm(directory, { recursive: true, force: true }); }
}, 20000);

test('runaway scripts time out off-thread, cancellation works and a later VM is healthy', async () => {
  const sandbox = createAgentSandbox();
  try {
    const result = await sandbox.execute('while (true) {}', { timeoutMs: 150 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('timeout');
    const controller = new AbortController();
    const pending = sandbox.execute('while (true) await null', { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    const aborted = await pending;
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.error.kind).toBe('aborted');
    expect(await sandbox.execute('return 42')).toMatchObject({ ok: true, value: 42 });
  } finally { await sandbox.close(); }
});
