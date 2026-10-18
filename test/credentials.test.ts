import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileCredentialStore } from '../agent/credentials.ts';

test('credential writes are private, detached, atomic across providers and persistent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-credentials-'));
  const file = join(directory, 'auth.json');
  try {
    const store = await FileCredentialStore.open(file);
    await Promise.all([
      store.modify('openai', async () => ({ type: 'api_key', key: 'fake-openai-key' })),
      store.modify('github-copilot', async () => ({ type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: Date.now() + 600000 })),
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.list()).toHaveLength(2);
    expect(JSON.stringify(await store.list())).not.toContain('fake-');
    const detached = await store.read('openai');
    if (detached?.type === 'api_key') detached.key = 'mutated';
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'fake-openai-key' });
    const reopened = await FileCredentialStore.open(file);
    expect(await reopened.list()).toHaveLength(2);
    await reopened.delete('openai');
    expect(await reopened.read('openai')).toBeUndefined();
    expect((await reopened.read('github-copilot'))?.type).toBe('oauth');
    expect(await readFile(file, 'utf8')).not.toContain('fake-openai-key');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a queued cancelled credential mutation cannot run or resurrect a logged-out account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-credential-race-'));
  try {
    const store = await FileCredentialStore.open(join(directory, 'auth.json'));
    const gate = Promise.withResolvers<void>();
    const holding = store.modify('anthropic', async () => { await gate.promise; return { type: 'api_key', key: 'held' }; });
    const controller = new AbortController();
    let called = false;
    const queued = store.modify('openai', async () => { called = true; return { type: 'api_key', key: 'must-not-save' }; }, { signal: controller.signal });
    const rejected = queued.then(() => null, error => error);
    const logout = store.delete('openai');
    controller.abort(); gate.resolve();
    await holding; expect(await rejected).not.toBeNull(); await logout;
    expect(called).toBe(false); expect(await store.read('openai')).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid credential header characters are rejected without echoing their values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-invalid-key-'));
  try {
    const store = await FileCredentialStore.open(join(directory, 'auth.json'));
    await expect(store.modify('openai', async () => ({ type: 'api_key', key: 'private-test-key\r\nInjected: header' }))).rejects.toThrow('Invalid API-key credential');
    expect(await store.list()).toHaveLength(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('corrupt credential JSON errors do not repeat secret-containing input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-invalid-credentials-'));
  try {
    const file = join(directory, 'auth.json');
    await writeFile(file, '{ "access": "do-not-echo-this-secret", invalid');
    await expect(FileCredentialStore.open(file)).rejects.toThrow('Invalid credentials file JSON');
    try { await FileCredentialStore.open(file); } catch (error) { expect(String(error)).not.toContain('do-not-echo-this-secret'); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
