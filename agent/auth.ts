import { randomUUID } from 'node:crypto';
import type { AuthEvent, AuthPrompt, Models, CredentialStore } from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';

// Public SDK hook: statically include the otherwise opaque lazy OAuth modules
// in our single-file Android bundle. This hook works under target Node as well.
registerBunOAuthFlows();
export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic · API key', device: false },
  { id: 'openai', label: 'OpenAI API · API key', device: false },
  { id: 'openai-codex', label: 'OpenAI · ChatGPT/Codex device login', device: true },
  { id: 'github-copilot', label: 'GitHub Copilot · device login', device: true },
] as const;
export type ProviderId = typeof PROVIDERS[number]['id'];
export type DeviceProvider = 'openai-codex' | 'github-copilot';
export function isProvider(value: unknown): value is ProviderId { return PROVIDERS.some(p => p.id === value); }
export function isDeviceProvider(value: unknown): value is DeviceProvider { return value === 'openai-codex' || value === 'github-copilot'; }

export function createAuthModels(store: CredentialStore) {
  // The app's credential file is authoritative: logout cannot resurrect an
  // ambient host key/token, and credentials aren't exported to shell env vars.
  const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(anthropicProvider()); models.setProvider(openaiProvider());
  models.setProvider(openaiCodexProvider()); models.setProvider(githubCopilotProvider());
  return models;
}

export function verificationUrl(provider: DeviceProvider, raw: string) {
  const url = new URL(raw);
  const expected = provider === 'openai-codex' ? ['auth.openai.com', '/codex/device'] : ['github.com', '/login/device'];
  if (url.protocol !== 'https:' || url.hostname !== expected[0] || url.pathname.replace(/\/$/, '') !== expected[1] ||
      (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash) throw new Error('Unexpected device verification URL');
  return url.href;
}

type Phase = 'starting' | 'waiting' | 'authorizing' | 'connected' | 'cancelled' | 'expired' | 'error';
export interface LoginView {
  id: string; provider: DeviceProvider; phase: Phase; message: string;
  device?: { userCode: string; verificationUri: string; expiresAt: number };
}
interface LoginSession {
  view: LoginView; controller: AbortController; task: Promise<void>;
  timer?: ReturnType<typeof setTimeout>; timedOut: boolean;
}
const working = (phase: Phase) => ['starting', 'waiting', 'authorizing'].includes(phase);

export class DeviceLoginManager {
  private current?: LoginSession;
  private closed = false;
  constructor(private models: Models, private store: CredentialStore, private timeoutMs = 15 * 60 * 1000) {}
  get busy() { return !!this.current && working(this.current.view.phase); }
  get login(): LoginView | null { return this.current ? structuredClone(this.current.view) : null; }

  async status() {
    const credentials = await this.store.list();
    return {
      providers: PROVIDERS.map(provider => {
        const entry = credentials.find(c => c.providerId === provider.id);
        return { ...provider, connected: !!entry, method: entry?.type ?? null };
      }),
      login: this.login,
    };
  }
  async connected(provider: string) { return (await this.store.list()).some(entry => entry.providerId === provider); }

  start(provider: DeviceProvider) {
    if (this.closed) throw new Error('Authentication is closing');
    if (this.busy) {
      if (this.current!.view.provider !== provider) throw new Error('Cancel the other pending sign-in first');
      return this.login;
    }
    const session: LoginSession = {
      view: { id: randomUUID(), provider, phase: 'starting', message: 'Getting a sign-in code…' },
      controller: new AbortController(), task: Promise.resolve(), timedOut: false,
    };
    this.current = session;
    session.timer = setTimeout(() => { session.timedOut = true; session.controller.abort(); }, this.timeoutMs);
    session.timer.unref?.();
    session.task = this.run(session);
    return this.login;
  }

  private async run(session: LoginSession) {
    const provider = session.view.provider;
    const prompt = async (value: AuthPrompt) => {
      session.controller.signal.throwIfAborted();
      if (provider === 'openai-codex' && value.type === 'select' && value.options.some(option => option.id === 'device_code')) return 'device_code';
      // Initial support is github.com, not arbitrary enterprise endpoints.
      if (provider === 'github-copilot' && value.type === 'text' && value.message.includes('Enterprise')) return '';
      throw new Error('This provider prompt is not part of the supported device flow');
    };
    const notify = (event: AuthEvent) => {
      if (session.controller.signal.aborted || this.current !== session) return;
      if (event.type === 'device_code') {
        if (typeof event.userCode !== 'string' || !/^[a-zA-Z0-9 -]{4,64}$/.test(event.userCode)) throw new Error('Invalid public device code');
        const seconds = event.expiresInSeconds ?? 900;
        if (!Number.isFinite(seconds) || seconds <= 0 || (event.intervalSeconds !== undefined && (!Number.isFinite(event.intervalSeconds) || event.intervalSeconds < 0))) throw new Error('Invalid device-code lifetime/interval');
        const lifetime = Math.min(this.timeoutMs, seconds * 1000);
        session.view = { ...session.view, phase: 'waiting', message: 'Waiting for approval…',
          device: { userCode: event.userCode, verificationUri: verificationUrl(provider, event.verificationUri), expiresAt: Date.now() + lifetime } };
      } else if (event.type === 'progress') {
        // Do not forward arbitrary provider response text into status/logs.
        session.view.phase = 'authorizing'; session.view.message = 'Finishing sign-in…';
      } else if (event.type === 'auth_url') {
        // A package/API change must not silently start browser/callback OAuth.
        throw new Error('Browser callback login is disabled; device code required');
      }
    };
    try {
      await this.models.login(provider, 'oauth', { signal: session.controller.signal, prompt, notify }, { agentName: 'Mushi' });
      // SDK mutation admission is the commit boundary. A cancel received after
      // that boundary may finish successfully; never falsely claim it rolled back.
      session.view = { id: session.view.id, provider, phase: 'connected', message: 'Signed in.' };
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      const expired = session.timedOut || /timed out|expired/i.test(text);
      const cancelled = session.controller.signal.aborted && !expired;
      session.view = { id: session.view.id, provider,
        phase: expired ? 'expired' : cancelled ? 'cancelled' : 'error',
        message: expired ? 'Device code expired. Start a new sign-in.' : cancelled ? 'Sign-in cancelled.' :
          /denied|access_denied/i.test(text) ? 'Authorization was denied. Start again if you want to sign in.' :
          provider === 'openai-codex' ? 'Sign-in failed. Check your connection/account access. OpenAI may require enabling device-code login in account settings.' :
          'Sign-in failed. Check your connection and GitHub Copilot account access, then retry.' };
      // No raw OAuth errors: upstream error bodies can contain credentials.
    } finally { clearTimeout(session.timer); }
  }

  async cancel(id: string) {
    if (!this.current || this.current.view.id !== id) throw new Error('Sign-in changed; refresh its status');
    if (working(this.current.view.phase)) this.current.controller.abort();
    await this.current.task;
  }
  async logout(provider: ProviderId) {
    if (this.current?.view.provider === provider) {
      if (working(this.current.view.phase)) this.current.controller.abort();
      await this.current.task;
      this.current = undefined;
    }
    // Wait for the admitted login mutation, then delete: a late completion must
    // never restore credentials after logout has acknowledged success.
    await this.models.logout(provider);
  }
  async close() {
    this.closed = true;
    if (this.busy) this.current!.controller.abort();
    await this.current?.task;
  }
}
