import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createAuthModels, DeviceLoginManager, isDeviceProvider, isProvider, type ProviderId } from './auth.ts';
import { FileCredentialStore } from './credentials.ts';
import { openAgent } from './harness.ts';

type Config = { provider: ProviderId; modelId: string };
if (!process.versions.bun) throw new Error('Mushi requires Bun; Node is not a runtime fallback');
const directory = process.env.MUSHI_HOME;
if (!directory) throw new Error('MUSHI_HOME must name an app-private directory');
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const configPath = join(directory, 'config.json');
const credentials = await FileCredentialStore.open(join(directory, 'auth.json'));
const models = createAuthModels(credentials);
const auth = new DeviceLoginManager(models, credentials);
let config: Config | undefined;
async function saveConfig(next: Config) {
  await writeFile(`${configPath}.tmp`, JSON.stringify(next), { mode: 0o600 });
  await rename(`${configPath}.tmp`, configPath);
}
try {
  let value;
  try { value = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error('Invalid agent configuration JSON');
  }
  if (!isProvider(value.provider) || typeof value.modelId !== 'string') throw new Error('Invalid agent configuration');
  config = { provider: value.provider, modelId: value.modelId };
  // One-time upgrade from the first APK's API-key-in-config format. Never
  // overwrite a newer credential, and remove the legacy secret after migration.
  if (typeof value.apiKey === 'string' && value.apiKey.trim() && !isDeviceProvider(config.provider)) {
    await credentials.modify(config.provider, async current => current ?? { type: 'api_key', key: value.apiKey.trim() });
  }
  if (Object.hasOwn(value, 'apiKey')) await saveConfig(config);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const agent = await openAgent(directory, models, config);
void agent.harness.closed.then(end => { if (end.reason === 'failed') process.exit(1); });
if (config) {
  await agent.conversation.configure({ model: { provider: config.provider, modelId: config.modelId } }, ctx);
  if (await isConfigured(config)) agent.resume();
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request exceeds 64 KiB');
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value;
}
function reply(res: ServerResponse, status: number, value: unknown) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Cache-Control': 'no-store', Connection: 'close' });
  res.end(data);
}
async function requireIdle() {
  if ((await agent.harness.inspect(ctx)).tasks.length) throw new Error('Abort the active run before changing authentication/settings');
}
async function isConfigured(selected = config) {
  return !!selected && await auth.connected(selected.provider) &&
    (await models.getAvailable(selected.provider)).some(model => model.id === selected.modelId);
}
async function catalog() {
  const saved = await credentials.list();
  const available = new Set((await models.getAvailable()).map(model => `${model.provider}/${model.id}`));
  return models.getModels().filter(model => model.provider !== 'github-copilot' ||
    !saved.some(c => c.providerId === model.provider) || available.has(`${model.provider}/${model.id}`))
    .map(({ provider, id, name }) => ({ provider, modelId: id, name }));
}
let shuttingDown = false;
async function route(req: IncomingMessage, res: ServerResponse) {
  if (shuttingDown) return reply(res, 503, { error: 'Agent is closing' });
  switch (`${req.method} ${req.url}`) {
    case 'GET /api/state': {
      const selected = config;
      return reply(res, 200, { view: agent.state, configured: await isConfigured(selected), authBusy: auth.busy, runtime: { engine: 'bun', version: process.versions.bun },
        model: selected ? { provider: selected.provider, modelId: selected.modelId } : null });
    }
    case 'GET /api/models': return reply(res, 200, await catalog());
    case 'GET /api/auth': return reply(res, 200, await auth.status());
    case 'POST /api/auth/start': {
      await requireIdle();
      const value = await body(req);
      if (!isDeviceProvider(value.provider)) throw new Error('Unsupported device-login provider');
      auth.start(value.provider);
      return reply(res, 200, await auth.status());
    }
    case 'POST /api/auth/cancel': {
      const value = await body(req);
      if (typeof value.id !== 'string') throw new Error('A sign-in attempt ID is required');
      await auth.cancel(value.id);
      return reply(res, 200, await auth.status());
    }
    case 'POST /api/auth/logout': {
      await requireIdle();
      const value = await body(req);
      if (!isProvider(value.provider)) throw new Error('Unsupported provider');
      await auth.logout(value.provider);
      return reply(res, 200, await auth.status());
    }
    case 'POST /api/config': {
      await requireIdle();
      if (auth.busy) throw new Error('Finish or cancel device sign-in before saving settings');
      const value = await body(req);
      if (!isProvider(value.provider)) throw new Error('Unsupported provider');
      if (typeof value.modelId !== 'string' || !models.getModel(value.provider, value.modelId)) throw new Error('Unknown model');
      if (value.apiKey !== undefined && typeof value.apiKey !== 'string') throw new Error('Invalid API key');
      const key = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
      if (key) {
        if (isDeviceProvider(value.provider)) throw new Error('Use device login for this provider');
        await credentials.modify(value.provider, async () => ({ type: 'api_key', key }));
      }
      if (!await auth.connected(value.provider)) throw new Error(isDeviceProvider(value.provider) ? 'Sign in before saving this model' : 'An API key is required');
      if (!(await models.getAvailable(value.provider)).some(model => model.id === value.modelId)) throw new Error('This model is not enabled for the signed-in account');
      const next: Config = { provider: value.provider, modelId: value.modelId };
      await saveConfig(next);
      await agent.conversation.configure({ model: next }, ctx);
      config = next;
      agent.resume();
      return reply(res, 200, { ok: true });
    }
    case 'POST /api/submit': {
      if (auth.busy) throw new Error('Finish or cancel device sign-in first');
      if (!await isConfigured()) throw new Error('Configure and sign in to an available provider/model first');
      const value = await body(req);
      if (typeof value.text !== 'string' || !value.text.trim()) throw new Error('A message is required');
      if (typeof value.requestId !== 'string' || !/^[\w-]{1,128}$/.test(value.requestId)) throw new Error('A stable requestId is required');
      if (value.whenBusy !== undefined && value.whenBusy !== 'steer' && value.whenBusy !== 'followUp') throw new Error('Invalid busy mode');
      const submission = await agent.conversation.submit({ type: 'input', content: value.text, requestId: value.requestId, whenBusy: value.whenBusy as 'steer' | 'followUp' | undefined }, ctx);
      return reply(res, 200, { id: submission.id });
    }
    case 'POST /api/abort':
      await agent.conversation.abort(ctx, { background: true }); return reply(res, 200, { ok: true });
    case 'POST /api/reset':
      await agent.conversation.reset(undefined, ctx); return reply(res, 200, { ok: true });
    case 'POST /api/shutdown':
      reply(res, 200, { ok: true }); void shutdown(); return;
    default: return reply(res, 404, { error: 'Not found' });
  }
}
const socket = join(directory, 'agent.sock');
// start-agent.sh's inherited flock owns this single-writer storage for our lifetime.
await unlink(socket).catch(e => { if (e.code !== 'ENOENT') throw e; });
let mutations: Promise<void> = Promise.resolve();
const server = createServer((req, res) => {
  const operation = req.method === 'POST' && req.url !== '/api/shutdown' ? mutations.then(() => route(req, res)) : route(req, res);
  if (req.method === 'POST' && req.url !== '/api/shutdown') mutations = operation.then(() => {}, () => {});
  void operation.catch(e => {
    if (!res.headersSent) reply(res, 400, { error: e instanceof Error ? e.message : 'Request failed' }); else res.destroy();
  });
});
server.requestTimeout = 30_000; server.headersTimeout = 10_000;
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
await chmod(socket, 0o600);
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  server.close(); server.closeAllConnections();
  await auth.close();
  await agent.close();
  // A rotated refresh token must settle even if its caller was cancelled.
  await credentials.flush();
  await unlink(socket).catch(() => {});
  clearTimeout(deadline); process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
console.log(`Mushi ready on app-private Unix socket · Bun ${process.versions.bun}`);
