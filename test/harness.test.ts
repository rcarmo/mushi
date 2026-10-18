import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openAgent } from '../agent/harness.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'mushi-test-')); directories.push(dir);
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  return { dir, faux, models, model: { provider: 'faux', modelId: 'faux-1' } };
}
test('SQLite reopens the same conversation and deduplicates admitted request IDs', async () => {
  const { dir, faux, models, model } = await fixture();
  faux.setResponses([fauxAssistantMessage('Persisted answer')]);
  let agent = await openAgent(dir, models, model);
  const first = await agent.conversation.submit({ type: 'input', content: 'Hello', requestId: 'request-1' }, ctx);
  expect((await first.wait(ctx)).status).toBe('done');
  const conversationId = agent.conversation.id;
  await agent.close();
  agent = await openAgent(dir, models);
  try {
    const again = await agent.conversation.submit({ type: 'input', content: 'Hello', requestId: 'request-1' }, ctx);
    expect(again.id).toBe(first.id);
    expect(agent.conversation.id).toBe(conversationId);
    expect(faux.state.callCount).toBe(1);
    const view = await agent.conversation.context(ctx);
    expect(JSON.stringify(view.entries)).toContain('Persisted answer');
  } finally { await agent.close(); }
});

test('coding tools execute in the persistent workspace and publish a result', async () => {
  const { dir, faux, models, model } = await fixture();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'printf native > proof.txt; pwd' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done'),
  ]);
  const agent = await openAgent(dir, models, model);
  try {
    const submitted = await agent.conversation.submit({ type: 'input', content: 'Write a file', requestId: 'tools-1' }, ctx);
    expect((await submitted.wait(ctx)).status).toBe('done');
    expect(await readFile(join(dir, 'workspace/proof.txt'), 'utf8')).toBe('native');
    const view = await agent.conversation.context(ctx);
    expect(JSON.stringify(view.entries)).toContain(join(dir, 'workspace'));
    expect(view.entries.some(e => e.kind === 'pi.tool-result')).toBe(true);
  } finally { await agent.close(); }
});

test('pending generation resumes after close, without duplicating the input', async () => {
  const { dir, faux, models, model } = await fixture();
  // Slow streaming ensures close catches a live generation.
  const slow = fauxProvider({ tokensPerSecond: 5 });
  models.setProvider(slow.provider);
  slow.setResponses([fauxAssistantMessage('A long answer that should be interrupted')]);
  let agent = await openAgent(dir, models, model);
  const submitted = await agent.conversation.submit({ type: 'input', content: 'Recover me', requestId: 'resume-1' }, ctx);
  await Bun.sleep(80);
  expect((await agent.harness.inspect(ctx)).tasks.length).toBeGreaterThan(0);
  await agent.close();
  faux.setResponses([fauxAssistantMessage('Recovered')]); models.setProvider(faux.provider);
  agent = await openAgent(dir, models);
  try {
    agent.resume();
    const recovered = await agent.harness.submission(submitted.id, ctx);
    expect((await recovered!.wait(ctx)).status).toBe('done');
    const history = await agent.conversation.context(ctx);
    expect(history.entries.filter(e => e.kind === 'pi.user')).toHaveLength(1);
    expect(JSON.stringify(history.entries)).toContain('Recovered');
  } finally { await agent.close(); }
}, 15000);
