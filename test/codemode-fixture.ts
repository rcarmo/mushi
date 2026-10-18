import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openAgent } from '../agent/harness.ts';

export async function codemodeSmoke(directory: string) {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  let declared = false;
  const code = `
const found = await searchTools('read bash write edit');
const description = await describeTool('bash');
const catalog = await models.getModelsOfType('chat');
const available = await models.getAvailableOfType('chat');
const model = await models.getModelOfType('chat', 'faux', 'faux-1');
const classifiers = await models.getAvailableOfType('classifier');
const painters = await models.getAvailableOfType('image');
if (!ALL_TOOLS.some(t => t.name === 'bash') || !found || !description || !catalog.length || !available.length || !model) throw Error('Discovery failed');
if (typeof models.classify !== 'function' || typeof models.generateImages !== 'function' || typeof image !== 'function' || typeof exit !== 'function') throw Error('Incomplete API');
if (typeof process !== 'undefined' || typeof fetch !== 'undefined' || typeof require !== 'undefined') throw Error('Host leaked');
await tools.write({ path: 'codemode.txt', content: 'before' });
await tools.edit({ path: 'codemode.txt', edits: [{ oldText: 'before', newText: 'after' }] });
const [read, shell] = await Promise.all([tools.read({ path: 'codemode.txt' }), tools.bash({ command: 'printf hidden-large-output; exit 7' })]);
if (!read.includes('after') || shell.exitCode !== 7) throw Error('Nested tool result mapping failed');
let caught = false;
try { await tools.read({ path: 'missing-codemode-file' }); } catch (_) { caught = true; }
if (!caught) throw Error('Tool errors did not reject');
store('proof', { read, exitCode: shell.exitCode });
text('filtered-codemode-output');
return { tools: ALL_TOOLS.map(t => t.name), classifiers: classifiers.length, painters: painters.length };
`;
  faux.setResponses([
    context => {
      const tools = context.messages.flatMap(message => message.role === 'system' ? message.toolsAdded ?? [] : []);
      declared = ['codemode', 'read', 'write', 'edit', 'bash'].every(name => tools.some(t => t.name === name));
      return fauxAssistantMessage(fauxToolCall('codemode', { code }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('Script completed'),
  ]);
  let agent = await openAgent(directory, models, { provider: 'faux', modelId: 'faux-1' });
  try {
    const submission = await agent.conversation.submit({ type: 'input', content: 'Exercise codemode', requestId: 'codemode-smoke' }, ctx);
    if ((await submission.wait(ctx)).status !== 'done' || !declared) throw Error('Codemode not declared or run unfinished');
    let history = await agent.conversation.context(ctx);
    const results = history.entries.flatMap(e => e.model ?? []).filter(m => m.role === 'toolResult');
    const result = JSON.stringify(results.map(m => m.content));
    if (results.some(m => m.isError) || !result.includes('filtered-codemode-output') || result.includes('hidden-large-output')) throw Error('Codemode execution/filtering failed: ' + result);
    await agent.close();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('codemode', { code: "const value = load('proof'); if (value?.exitCode !== 7) throw Error('Store lost'); return 'persisted-store-ok';" }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Store checked'),
    ]);
    agent = await openAgent(directory, models);
    const check = await agent.conversation.submit({ type: 'input', content: 'Check stored state', requestId: 'codemode-store-smoke' }, ctx);
    if ((await check.wait(ctx)).status !== 'done') throw Error('Store check unfinished');
    history = await agent.conversation.context(ctx);
    if (!JSON.stringify(history.entries).includes('persisted-store-ok')) throw Error('Codemode store did not survive reopen');
    return { declared: true, nestedTools: ['read', 'write', 'edit', 'bash'], parallel: true, filteredOutput: true, storeReopened: true, discovery: true, modelHelpers: true, isolatedVm: true };
  } finally { await agent.close(); }
}
