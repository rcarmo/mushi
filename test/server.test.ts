import { expect, test } from 'bun:test';
import { request } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function call(socketPath: string, path: string, body?: unknown) {
  return new Promise<{ status: number; value: any }>((resolve, reject) => {
    const req = request({ socketPath, path, method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode!, value: JSON.parse(text) }); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('bundled daemon serves only the private socket and validates requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-server-'));
  const child = Bun.spawn([process.execPath, 'build/assets/mushi/agent.mjs'], {
    env: { ...process.env, MUSHI_HOME: directory }, stdout: 'pipe', stderr: 'pipe',
  });
  const socket = join(directory, 'agent.sock');
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        // bind() creates the socket with umask-derived 0700 before the daemon's
        // explicit chmod(0600). Existence alone is not its readiness boundary.
        if (((await stat(socket)).mode & 0o777) === 0o600) { ready = true; break; }
      } catch { /* Not bound yet. */ }
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    const state = await call(socket, '/api/state');
    expect(state.status).toBe(200); expect(state.value.configured).toBe(false);
    expect(JSON.stringify(state.value)).not.toContain('apiKey');
    const models = await call(socket, '/api/models');
    expect(models.value.some((m: any) => m.provider === 'anthropic')).toBe(true);
    expect(models.value.some((m: any) => m.provider === 'openai-codex')).toBe(true);
    expect(models.value.some((m: any) => m.provider === 'github-copilot')).toBe(true);
    const auth = await call(socket, '/api/auth');
    expect(auth.value.providers).toHaveLength(4);
    expect(auth.value.providers.every((p: any) => !p.connected)).toBe(true);
    expect((await call(socket, '/api/auth/start', { provider: 'openai' })).status).toBe(400);
    expect((await call(socket, '/api/auth/cancel', { id: 'stale-attempt' })).status).toBe(400);
    expect((await call(socket, '/api/submit', { text: 'test', requestId: 'id' })).status).toBe(400);
    expect((await call(socket, '/api/config', { provider: 'wrong', modelId: 'fake', apiKey: 'key' })).status).toBe(400);
    expect((await call(socket, '/api/config', { provider: 'openai', modelId: 'not-a-model', apiKey: 'key' })).status).toBe(400);
    expect((await call(socket, '/api/nope')).status).toBe(404);
    const openai = models.value.find((m: any) => m.provider === 'openai');
    expect((await call(socket, '/api/config', { provider: 'openai', modelId: openai.modelId, apiKey: 'not-a-real-key' })).status).toBe(200);
    expect((await stat(join(directory, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, 'config.json'), 'utf8')).not.toContain('not-a-real-key');
    const configured = await call(socket, '/api/state');
    expect(configured.value.configured).toBe(true);
    expect(JSON.stringify(configured.value)).not.toContain('not-a-real-key');
    const logout = await call(socket, '/api/auth/logout', { provider: 'openai' });
    expect(logout.status).toBe(200);
    expect((await call(socket, '/api/state')).value.configured).toBe(false);
    expect(await readFile(join(directory, 'auth.json'), 'utf8')).not.toContain('not-a-real-key');
    expect((await call(socket, '/api/shutdown', {})).status).toBe(200);
    expect(await child.exited).toBe(0);
  } finally {
    child.kill(); await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
