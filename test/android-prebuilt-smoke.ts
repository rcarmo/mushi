// Bundled by Bun and executed by the actual Android/Bionic Bun binary.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openAgent } from '../agent/harness.ts';
import { androidAuthSmoke } from './android-auth-smoke.ts';
import { codemodeSmoke } from './codemode-fixture.ts';
import { createAgentSandbox } from '../agent/codemode.ts';
import { utilityToolsSmoke } from './utility-tools-fixture.ts';
import { requestHttp, parseSearchFeed } from '../agent/network-tools.ts';

if (process.platform !== 'android' || process.arch !== 'arm64' || !process.versions.bun) throw new Error('This test requires the real Android ARM64 Bun runtime');
const directory = await mkdtemp(join(process.env.HOME!, '.mushi-prebuilt-smoke-'));
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
let agent: Awaited<ReturnType<typeof openAgent>> | undefined;
try {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: 'proof.txt', content: 'before\n' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('edit', { path: 'proof.txt', edits: [{ oldText: 'before', newText: 'after' }] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('read', { path: 'proof.txt' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'set -e; test "$(cat proof.txt)" = after; git init -q; git -c user.name=Mushi -c user.email=mushi@example.invalid add proof.txt; git -c user.name=Mushi -c user.email=mushi@example.invalid commit -qm smoke; git -c alias.check="!echo git-alias-ok" check; git log -1 --format=%s; printf bash-ok' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Android native tools complete'),
  ]);
  agent = await openAgent(directory, models, { provider: 'faux', modelId: 'faux-1' });
  const submitted = await agent.conversation.submit({ type: 'input', content: 'Exercise the native tools', requestId: 'android-prebuilt-smoke' }, ctx);
  const settled = await submitted.wait(ctx);
  assert(settled.status === 'done', 'Native tool run did not finish');
  const context = await agent.conversation.context(ctx);
  const results = context.entries.flatMap(e => e.model || []).filter(m => m.role === 'toolResult');
  assert(results.length === 4, `Expected four tool results, received ${results.length}`);
  assert(results.every(m => !m.isError), 'A native tool failed: ' + JSON.stringify(results));
  assert(JSON.stringify(results).includes('git-alias-ok'), 'Prebuilt git alias/exec bridge failed');
  assert((await readFile(join(directory, 'workspace/proof.txt'), 'utf8')) === 'after\n', 'Write/edit/read did not persist');
  await agent.close(); agent = undefined;
  agent = await openAgent(directory, models);
  const duplicate = await agent.conversation.submit({ type: 'input', content: 'Exercise the native tools', requestId: 'android-prebuilt-smoke' }, ctx);
  assert(duplicate.id === submitted.id, 'Reopen did not deduplicate the native SQLite submission');
  assert(faux.state.callCount === 5, 'Reopen unexpectedly repeated generation');
  const authentication = await androidAuthSmoke(directory);
  const codemode = await codemodeSmoke(join(directory, 'codemode'));
  const utilityTools = await utilityToolsSmoke(join(directory, 'utilities'));
  const sandbox = createAgentSandbox();
  try {
    const timed = await sandbox.execute('while (true) {}', { timeoutMs: 200 });
    assert(!timed.ok && timed.error.kind === 'timeout', 'Android spinning WASM was not interrupted');
    const controller = new AbortController();
    const pending = sandbox.execute('while (true) await null', { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const cancelled = await pending;
    assert(!cancelled.ok && cancelled.error.kind === 'aborted', 'Android script cancellation failed');
    const healthy = await sandbox.execute('return 42');
    assert(healthy.ok && healthy.value === 42, 'Android worker unhealthy after interrupt');
  } finally { await sandbox.close(); }
  let httpsStatus: number | null = null;
  let publicSearch: { status: number; results?: number; error?: string } | null = null;
  if (process.env.MUSHI_SMOKE_HTTPS === '1') {
    httpsStatus = (await fetch('https://example.com', { signal: AbortSignal.timeout(15000) })).status;
    assert(httpsStatus === 200, 'Relocated HTTPS/certificate check failed');
    const search = await requestHttp({ url: 'https://www.bing.com/search?format=rss&q=Bun%20JavaScript%20runtime', timeout_ms: 15000 });
    try { publicSearch = { status: search.status, results: parseSearchFeed(search.body, 5).length }; }
    catch (error) { publicSearch = { status: search.status, error: error instanceof Error ? error.message : String(error) }; }
  }
  console.log(JSON.stringify({ ok: true, runtime: `Bun ${process.versions.bun}`, engine: 'bun', platform: process.platform, architecture: process.arch,
    tools: ['write', 'edit', 'read', 'bash', 'git'], sqliteReopen: true, submissionDeduplicated: true, httpsStatus, authentication, utilityTools, publicSearch, codemode: { ...codemode, timeout: true, cancellation: true }, emulation: false }));
} finally {
  if (agent) await agent.close();
  await rm(directory, { recursive: true, force: true });
}
