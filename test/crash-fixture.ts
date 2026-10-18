import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { awaitWithContext, BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

export async function openCrashFixture(directory: string, first: boolean) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'test-unsafe', tools: [defineTool({
    name: 'effect', description: 'An effect that must not be replayed', parameters: Type.Object({}), replay: 'unsafe',
    async execute(_args, _api, context) {
      await appendFile(join(directory, 'effects.txt'), 'effect\n');
      console.log('effect-started');
      await awaitWithContext(new Promise(() => {}), context);
      return {};
    },
  })] }));
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses(first ? [fauxAssistantMessage(fauxToolCall('effect', {}), { stopReason: 'toolUse' })] : [fauxAssistantMessage('Recovered without replay')]);
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'session.sqlite')), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  return { harness, root };
}
if (import.meta.main) {
  const { root } = await openCrashFixture(process.argv[2]!, true);
  await root.submit({ type: 'input', content: 'Do one effect', requestId: 'hard-crash' }, ctx);
  setInterval(() => {}, 1000);
}
