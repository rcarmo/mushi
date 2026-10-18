import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuthModels, DeviceLoginManager, verificationUrl } from '../agent/auth.ts';
import { FileCredentialStore } from '../agent/credentials.ts';

const jwt = (account = 'fake-account') => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64')}.fake`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
async function until(fn: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() >= end) throw new Error('Auth test timed out'); await Bun.sleep(10); }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-device-auth-'));
  const store = await FileCredentialStore.open(join(directory, 'auth.json'));
  const models = createAuthModels(store);
  const auth = new DeviceLoginManager(models, store);
  return { directory, store, models, auth, async close() { await auth.close(); await store.flush(); await rm(directory, { recursive: true, force: true }); } };
}
function waitForResponse(promise: Promise<Response>, signal?: AbortSignal | null) {
  if (!signal) return promise;
  return new Promise<Response>((resolve, reject) => {
    const cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

test('SDK OpenAI device flow exposes only the public code and persists/refreshed credentials', async () => {
  const f = await fixture(); const original = globalThis.fetch;
  const approved = Promise.withResolvers<Response>();
  let refreshes = 0; const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    if (url.endsWith('/deviceauth/usercode')) return json({ device_auth_id: 'private-device-auth-id', user_code: 'TEST-CODE', interval: 1 });
    if (url.endsWith('/deviceauth/token')) return waitForResponse(approved.promise, init?.signal);
    if (url === 'https://auth.openai.com/oauth/token') {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'refresh_token') { refreshes++; return json({ access_token: jwt('refreshed-account'), refresh_token: 'rotated-refresh-secret', expires_in: 3600 }); }
      return json({ access_token: jwt(), refresh_token: 'initial-refresh-secret', expires_in: 3600 });
    }
    throw new Error('Unexpected OAuth network request');
  }) as typeof fetch;
  try {
    const first = f.auth.start('openai-codex');
    expect(first?.phase).toBe('starting');
    expect(f.auth.start('openai-codex')?.id).toBe(first?.id); // idempotent while pending
    await until(() => f.auth.login?.phase === 'waiting');
    const visible = JSON.stringify(await f.auth.status());
    expect(visible).toContain('TEST-CODE'); expect(visible).toContain('https://auth.openai.com/codex/device');
    expect(visible).not.toContain('private-device-auth-id');
    approved.resolve(json({ authorization_code: 'private-authorization-code', code_verifier: 'private-code-verifier' }));
    await until(() => f.auth.login?.phase === 'connected');
    expect(await f.auth.connected('openai-codex')).toBe(true);
    expect((await f.store.read('openai-codex'))?.type).toBe('oauth');
    const publicState = JSON.stringify(await f.auth.status());
    for (const secret of ['initial-refresh-secret', 'private-code-verifier', 'private-authorization-code', jwt()]) expect(publicState).not.toContain(secret);
    expect(requests.some(url => url.includes('/oauth/authorize'))).toBe(false);
    // SDK auto-refresh is serialized; concurrent model requests rotate once.
    await f.store.modify('openai-codex', async credential => credential?.type === 'oauth' ? { ...credential, expires: 0 } : undefined);
    await Promise.all(Array.from({ length: 4 }, () => f.models.getAuth('openai-codex')));
    expect(refreshes).toBe(1);
    const reopened = await FileCredentialStore.open(join(f.directory, 'auth.json'));
    const saved = await reopened.read('openai-codex');
    expect(saved?.type === 'oauth' && saved.refresh).toBe('rotated-refresh-secret');
  } finally { globalThis.fetch = original; await f.close(); }
}, 15000);

test('SDK GitHub device login uses Copilot scope, filters account models and logs out', async () => {
  const f = await fixture(); const original = globalThis.fetch;
  const allowed = f.models.getModels('github-copilot')[0]!.id;
  let scope: string | null = null;
  const polls: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://github.com/login/device/code') {
      scope = new URLSearchParams(String(init?.body)).get('scope');
      return json({ device_code: 'private-github-device-code', user_code: 'GHUB-CODE', verification_uri: 'https://github.com/login/device', interval: 0, expires_in: 900 });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      polls.push(Date.now());
      if (polls.length === 1) return json({ error: 'authorization_pending' });
      if (polls.length === 2) return json({ error: 'slow_down', interval: 2 });
      return json({ access_token: 'private-github-token' });
    }
    if (url === 'https://api.github.com/copilot_internal/v2/token') return json({ token: 'private-copilot-token;proxy-ep=proxy.individual.githubcopilot.com;', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    if (url === 'https://api.individual.githubcopilot.com/models') return json({ data: [{ id: allowed, model_picker_enabled: true, capabilities: { supports: { tool_calls: true } }, policy: { state: 'enabled' } }] });
    throw new Error('Unexpected GitHub network request');
  }) as typeof fetch;
  try {
    f.auth.start('github-copilot');
    await until(() => f.auth.login?.phase === 'waiting');
    expect(JSON.stringify(await f.auth.status())).not.toContain('private-github-device-code');
    await until(() => f.auth.login?.phase === 'connected');
    expect(scope!).toBe('read:user'); // deliberately not repo/git authorization
    expect(polls).toHaveLength(3);
    expect(polls[1]! - polls[0]!).toBeGreaterThanOrEqual(900);
    expect(polls[2]! - polls[1]!).toBeGreaterThanOrEqual(1900);
    expect((await f.models.getAvailable('github-copilot')).map(model => model.id)).toEqual([allowed]);
    expect(JSON.stringify(await f.auth.status())).not.toContain('private-copilot-token');
    await f.auth.logout('github-copilot');
    expect(await f.auth.connected('github-copilot')).toBe(false);
    expect(await f.models.getAuth('github-copilot')).toBeUndefined();
    expect(await readFile(join(f.directory, 'auth.json'), 'utf8')).not.toContain('private-github-token');
  } finally { globalThis.fetch = original; await f.close(); }
}, 15000);

test('cancelling/logging out a pending SDK flow cannot save a late credential', async () => {
  const f = await fixture(); const original = globalThis.fetch;
  const delayed = Promise.withResolvers<Response>();
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/deviceauth/usercode')) return json({ device_auth_id: 'hidden-device', user_code: 'CANC-CODE', interval: 1 });
    if (String(input).endsWith('/deviceauth/token')) return delayed.promise; // deliberately ignores abort
    if (String(input).endsWith('/oauth/token')) return json({ access_token: jwt(), refresh_token: 'must-not-be-saved', expires_in: 3600 });
    throw new Error('Unexpected request');
  }) as typeof fetch;
  try {
    f.auth.start('openai-codex'); await until(() => f.auth.login?.phase === 'waiting');
    await f.auth.logout('openai-codex');
    delayed.resolve(json({ authorization_code: 'late-code', code_verifier: 'late-verifier' }));
    await Bun.sleep(50); await f.store.flush();
    expect(await f.store.read('openai-codex')).toBeUndefined();
    expect(f.auth.login).toBeNull();
  } finally { delayed.resolve(json({})); globalThis.fetch = original; await f.close(); }
});

test('device verification URLs cannot open arbitrary sites, schemes, credentials or redirects', () => {
  expect(verificationUrl('openai-codex', 'https://auth.openai.com/codex/device')).toBe('https://auth.openai.com/codex/device');
  expect(verificationUrl('github-copilot', 'https://github.com/login/device')).toBe('https://github.com/login/device');
  for (const value of ['http://github.com/login/device', 'https://evil.test/login/device', 'intent://github.com/login/device', 'https://github.com@evil.test/login/device', 'https://github.com/login/device?redirect=evil', 'https://github.com:444/login/device']) {
    expect(() => verificationUrl('github-copilot', value)).toThrow();
  }
});

test('failed login reports are sanitized and no failed credentials are stored', async () => {
  const f = await fixture(); const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => json({ private_token: 'do-not-display-this' }, 500)) as typeof fetch;
  try {
    f.auth.start('openai-codex'); await until(() => f.auth.login?.phase === 'error');
    expect(JSON.stringify(await f.auth.status())).not.toContain('do-not-display-this');
    expect(await f.store.list()).toHaveLength(0);
  } finally { globalThis.fetch = original; await f.close(); }
});
