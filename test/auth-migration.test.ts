import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { createAuthModels } from '../agent/auth.ts';
import { FileCredentialStore } from '../agent/credentials.ts';
function call(socketPath: string, path: string, body?: object) {
  return new Promise<any>((resolve, reject) => {
    const req = request({ socketPath, path, method: body ? 'POST' : 'GET' }, response => {
      let text = ''; response.on('data', data => { text += data; }); response.on('end', () => {
        try { if (response.statusCode !== 200) throw new Error(text); resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('old API-key config migrates privately and logout cannot fall back to an ambient key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-auth-migration-'));
  const catalog = createAuthModels(await FileCredentialStore.open(join(directory, 'unused-auth.json')));
  const model = catalog.getModels('openai')[0]!.id;
  await writeFile(join(directory, 'config.json'), JSON.stringify({ provider: 'openai', modelId: model, apiKey: 'legacy-secret-for-test' }));
  const child = Bun.spawn([process.execPath, 'build/assets/mushi/agent.mjs'], {
    env: { ...process.env, MUSHI_HOME: directory, OPENAI_API_KEY: 'ambient-key-must-not-resurrect' }, stdout: 'pipe', stderr: 'pipe',
  });
  const socket = join(directory, 'agent.sock');
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if (((await stat(socket)).mode & 0o777) === 0o600) { ready = true; break; } } catch { }
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(30);
    }
    expect(ready).toBe(true);
    expect((await call(socket, '/api/state')).configured).toBe(true);
    expect(await readFile(join(directory, 'config.json'), 'utf8')).not.toContain('legacy-secret-for-test');
    const auth = await call(socket, '/api/auth');
    expect(JSON.stringify(auth)).not.toContain('legacy-secret-for-test');
    expect(auth.providers.find((p: any) => p.id === 'openai').method).toBe('api_key');
    const store = await FileCredentialStore.open(join(directory, 'auth.json'));
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'legacy-secret-for-test' });
    await call(socket, '/api/auth/logout', { provider: 'openai' });
    expect((await call(socket, '/api/state')).configured).toBe(false);
    expect(await readFile(join(directory, 'auth.json'), 'utf8')).not.toContain('legacy-secret-for-test');
    await call(socket, '/api/shutdown', {}); expect(await child.exited).toBe(0);
  } finally { child.kill(); await child.exited; await rm(directory, { recursive: true, force: true }); }
}, 15000);
