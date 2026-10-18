// A real Android/Bun process is SIGKILLed by smoke-runtime.ts after effect intent.
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx, awaitWithContext } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { createAgentSandbox } from '../agent/codemode.ts';
if (!process.versions.bun || process.platform !== 'android') throw new Error('Requires Android Bun');
const directory = process.env.MUSHI_RECOVERY_DIRECTORY!;
const resume = process.env.MUSHI_RECOVERY_PHASE === 'resume';
const registry = createRegistry();
const sandbox = createAgentSandbox();
registry.install(createCodemodeExtension({ sandbox }));
registry.install(defineExtension({ name: 'smoke-effect', tools: [defineTool({
  name: 'completed', description: 'Completed effect before interruption', parameters: Type.Object({}), replay: 'unsafe',
  async execute() {
    await appendFile(join(directory, 'completed.txt'), 'once\n');
    return { output: [{ type: 'text', text: 'committed' }] };
  },
}), defineTool({
  name: 'effect', description: 'Unsafe fixture effect', parameters: Type.Object({}), replay: 'unsafe',
  async execute(_args, _api, context) {
    await appendFile(join(directory, 'effects.txt'), 'once\n');
    await awaitWithContext(new Promise(() => {}), context);
    return {};
  },
})] }));
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
faux.setResponses(resume ? [fauxAssistantMessage('Recovered without replay')] : [fauxAssistantMessage(fauxToolCall('codemode', { code: "await tools.completed({}); try { await tools.effect({}); } catch (error) { text(error.message); } return 'codemode-resumed';" }), { stopReason: 'toolUse' })]);
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'session.sqlite')), { models, registry }, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
const submission = await root.submit({ type: 'input', content: 'One effect', requestId: 'bun-recovery' }, ctx);
if (!resume) setInterval(() => {}, 1000);
else {
  const settled = await submission.wait(ctx), history = await root.context(ctx);
  if (settled.status !== 'done' || await readFile(join(directory, 'effects.txt'), 'utf8') !== 'once\n' ||
      await readFile(join(directory, 'completed.txt'), 'utf8') !== 'once\n' ||
      !JSON.stringify(history.entries).includes('codemode-resumed') || !JSON.stringify(history.entries).includes('interrupted') || history.entries.filter(entry => entry.kind === 'pi.user').length !== 1) throw new Error('Bun crash recovery failed');
  await harness.close(ctx);
  await sandbox.close();
  console.log(JSON.stringify({ engine: 'bun', version: process.versions.bun, sigkillRecovered: true, unsafeToolNotReplayed: true, codemodeResumed: true, completedNestedEffectNotReplayed: true }));
}
