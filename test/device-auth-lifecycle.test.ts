import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuthModels, DeviceLoginManager } from '../agent/auth.ts';
import { FileCredentialStore } from '../agent/credentials.ts';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64')}.fake`;
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await Bun.sleep(10); }
  throw new Error('Auth lifecycle test timed out');
}

test('a bounded device session expires and clears its public code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-auth-timeout-'));
  const store = await FileCredentialStore.open(join(directory, 'auth.json'));
  const auth = new DeviceLoginManager(createAuthModels(store), store, 30);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/usercode')) return json({ device_auth_id: 'private-device', user_code: 'TIME-CODE', interval: 1 });
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      init?.signal?.addEventListener('abort', abort, { once: true });
      if (init?.signal?.aborted) abort();
    });
  }) as typeof fetch;
  try {
    auth.start('openai-codex');
    await until(() => auth.login?.phase === 'expired');
    expect(auth.login?.device).toBeUndefined(); expect(auth.busy).toBe(false);
    expect(await store.list()).toHaveLength(0);
  } finally { await auth.close(); globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});

test('caller cancellation does not discard a rotated SDK refresh token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-refresh-cancel-'));
  const store = await FileCredentialStore.open(join(directory, 'auth.json'));
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'expired-access', refresh: 'old-refresh', expires: 0 }));
  const models = createAuthModels(store), original = globalThis.fetch;
  const gate = Promise.withResolvers<Response>(); let started = false; let refreshSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => { started = true; refreshSignal = init?.signal; return gate.promise; }) as typeof fetch;
  const controller = new AbortController();
  try {
    const waiting = models.getAuth('openai-codex', { signal: controller.signal }).then(() => null, error => error);
    await until(() => started); controller.abort();
    expect(await waiting).not.toBeNull(); expect(refreshSignal?.aborted).toBe(false);
    gate.resolve(json({ access_token: access, refresh_token: 'rotated-but-retained', expires_in: 3600 }));
    await store.flush();
    const reopened = await FileCredentialStore.open(join(directory, 'auth.json'));
    const credential = await reopened.read('openai-codex');
    expect(credential?.type === 'oauth' && credential.refresh).toBe('rotated-but-retained');
  } finally { gate.resolve(json({})); await store.flush(); globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});

test('logout waits for an already-admitted SDK login save, then removes it permanently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-auth-late-save-'));
  const store = await FileCredentialStore.open(join(directory, 'auth.json'));
  const originalModify = store.modify.bind(store), release = Promise.withResolvers<void>(); let admitted = false;
  store.modify = (id, fn, options) => originalModify(id, async current => {
    const next = await fn(current);
    if (id === 'openai-codex' && next) { admitted = true; await release.promise; }
    return next;
  }, options);
  const auth = new DeviceLoginManager(createAuthModels(store), store), original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/usercode')) return json({ device_auth_id: 'private-device', user_code: 'LATE-CODE', interval: 1 });
    if (String(input).endsWith('/deviceauth/token')) return json({ authorization_code: 'test-code', code_verifier: 'test-verifier' });
    return json({ access_token: access, refresh_token: 'must-delete-after-save', expires_in: 3600 });
  }) as typeof fetch;
  try {
    auth.start('openai-codex'); await until(() => admitted);
    const logout = auth.logout('openai-codex');
    release.resolve(); await logout; await store.flush();
    expect(auth.login).toBeNull(); expect(await store.read('openai-codex')).toBeUndefined();
    const reopened = await FileCredentialStore.open(join(directory, 'auth.json'));
    expect(await reopened.read('openai-codex')).toBeUndefined();
  } finally { release.resolve(); await auth.close(); globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});
