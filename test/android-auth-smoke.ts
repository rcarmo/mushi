// SDK OAuth + atomic credential persistence under the actual Android Bun binary.
// All OAuth HTTP responses are local fixtures; no real account authorization.
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { createAuthModels, DeviceLoginManager } from '../agent/auth.ts';
import { FileCredentialStore } from '../agent/credentials.ts';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
export async function androidAuthSmoke(directory: string) {
  const store = await FileCredentialStore.open(join(directory, 'auth.json'));
  const models = createAuthModels(store), auth = new DeviceLoginManager(models, store);
  const original = globalThis.fetch;
  const approval = Promise.withResolvers<Response>();
  const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'smoke-account' } })).toString('base64')}.fake`;
  const githubModel = models.getModels('github-copilot')[0]!.id;
  let refreshed = 0;
  const wait = async (phase: string) => {
    const end = Date.now() + 5000;
    while (auth.login?.phase !== phase) {
      if (Date.now() > end || auth.login?.phase === 'error') throw new Error(`Android OAuth fixture did not reach ${phase}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/deviceauth/usercode')) return json({ device_auth_id: 'not-public-device-id', user_code: 'MUSHI1-CODE', interval: 1 });
    if (url.endsWith('/deviceauth/token')) return approval.promise;
    if (url === 'https://auth.openai.com/oauth/token') {
      const refresh = new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token';
      if (refresh) refreshed++;
      return json({ access_token: access, refresh_token: refresh ? 'rotated-smoke-refresh' : 'initial-smoke-refresh', expires_in: 3600 });
    }
    if (url === 'https://github.com/login/device/code') return json({ device_code: 'not-public-github-device-id', user_code: 'MUSHI2-CODE', verification_uri: 'https://github.com/login/device', interval: 0, expires_in: 900 });
    if (url === 'https://github.com/login/oauth/access_token') return json({ access_token: 'smoke-github-secret' });
    if (url === 'https://api.github.com/copilot_internal/v2/token') return json({ token: 'smoke-copilot-secret;proxy-ep=proxy.individual.githubcopilot.com;', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    if (url === 'https://api.individual.githubcopilot.com/models') return json({ data: [{ id: githubModel, model_picker_enabled: true, policy: { state: 'enabled' }, capabilities: { supports: { tool_calls: true } } }] });
    throw new Error('Unexpected OAuth fixture request');
  }) as typeof fetch;
  try {
    auth.start('openai-codex'); await wait('waiting');
    const publicState = JSON.stringify(await auth.status());
    if (!publicState.includes('MUSHI1-CODE') || publicState.includes('not-public-device-id')) throw new Error('Unsafe Android auth status');
    approval.resolve(json({ authorization_code: 'smoke-code', code_verifier: 'smoke-verifier' }));
    await wait('connected');
    await store.modify('openai-codex', async value => value?.type === 'oauth' ? { ...value, expires: 0 } : undefined);
    await Promise.all([models.getAuth('openai-codex'), models.getAuth('openai-codex')]);
    if (refreshed !== 1) throw new Error('Android token refresh was not serialized');
    await auth.logout('openai-codex');
    auth.start('github-copilot'); await wait('connected');
    if ((await models.getAvailable('github-copilot')).length !== 1) throw new Error('Android Copilot model filtering failed');
    const reopened = await FileCredentialStore.open(join(directory, 'auth.json'));
    if ((await reopened.read('github-copilot'))?.type !== 'oauth') throw new Error('Android OAuth credentials did not persist');
    if (((await stat(join(directory, 'auth.json'))).mode & 0o777) !== 0o600) throw new Error('Unsafe Android auth file mode');
    await auth.logout('github-copilot');
    if ((await store.list()).length) throw new Error('Android logout did not remove credentials');
    return { providers: ['openai-codex', 'github-copilot'], deviceFlows: 'SDK fixtures', refreshPersisted: true, logout: true, privateCredentialFile: true };
  } finally { approval.resolve(json({})); await auth.close(); await store.flush(); globalThis.fetch = original; }
}
