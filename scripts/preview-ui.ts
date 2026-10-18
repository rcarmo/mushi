// Local-only manual design preview. No agent, credentials or model requests.
import { join } from 'node:path';
import { root } from './config.ts';
const view = {
  conversation: { id: 1 },
  entries: [
    { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'Make the session worker durable and check the build.' }] },
    { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'I’ll inspect the worker, make the change, then run the tests.' }, { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/session.ts', offset: 1, limit: 12 } }] }] },
    { id: 3, kind: 'pi.tool-result', data: { diagnostics: [] }, model: [{ role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: 'export async function runSession(input: string) {\n  const state = await store.open();\n  await state.submit(input);\n  return state.wait();\n}\n' }], isError: false, durationMs: 19 }] },
    { id: 4, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'src/session.ts', edits: [{ oldText: 'await state.submit(input);', newText: 'await state.submit(input, { requestId });' }] } }] }] },
    { id: 5, kind: 'pi.tool-result', data: { diagnostics: [] }, model: [{ role: 'toolResult', toolCallId: 'edit-1', toolName: 'edit', content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in src/session.ts.' }], isError: false, durationMs: 31, details: { patch: '--- a/src/session.ts\n+++ b/src/session.ts\n@@ -1,5 +1,5 @@\n export async function runSession(input: string) {\n   const state = await store.open();\n-  await state.submit(input);\n+  await state.submit(input, { requestId });\n   return state.wait();\n }\n' } }] },
    { id: 6, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'bun run check && bun test' } }] }] },
    { id: 7, kind: 'pi.tool-result', data: { diagnostics: [] }, model: [{ role: 'toolResult', toolCallId: 'bash-1', toolName: 'bash', content: [{ type: 'text', text: '\u001b[32m36 pass\u001b[0m\n0 fail\nRan 36 tests across 10 files. [1.45s]' }], isError: false, durationMs: 1450 }] },
    { id: 8, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '## {再開|さいかい}できました\n\n{準備|じゅんび}ができました。{日本語|にほんご}でお{手伝|てつだ}いします。\n\nRomaji: Junbi ga dekimashita. Nihongo de otetsudai shimasu.\n\nThe worker now saves a **stable request ID** before submitting work. Reopening a session finds the same submission instead of sending it twice.\n\n### What changed\n\n- Updated `src/session.ts` to reuse the request ID.\n- Kept interrupted tool calls recoverable.\n- Checked the types and ran the test suite.\n\n| Check | Result |\n| --- | --- |\n| TypeScript | Passed |\n| Recovery tests | 36 passed |\n| Replayed side effects | None |\n\n```typescript filename="src/session.ts"\nconst submission = await session.submit({\n  type: "input",\n  content: task,\n  requestId: pending.id,\n});\nawait submission.wait(context);\n```\n\n> Closing the UI doesn’t stop the foreground agent.\n\nSee the [Pi documentation](https://pi.dev) or inspect [the worker](src/session.ts).\n\nRaw HTML stays literal: <img src="https://invalid.test/track" onerror="window.attack=true">.' }] }] },
  ], docs: { 'pi.live': {}, 'pi.inbox': { items: [] } },
};
const fixture = `window.previewView=${JSON.stringify(view).replace(/</g, '\\u003c')};
window.previewCalls=[];
window.MushiNative={postMessage(raw){const req=JSON.parse(raw);window.previewCalls.push(req);let value={};
if(req.path==='/api/state')value={view:window.previewView,configured:false,authBusy:false,runtime:{engine:'bun',version:'1.4.3'},model:{provider:'openai-codex',modelId:'gpt-5'}};
else if(req.path==='/api/auth')value={providers:[],login:null};
else if(req.path==='/api/models')value=[];
queueMicrotask(()=>window.mushiReply(req.id,{value}));}};`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 4173, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } });
  if (path === '/') {
    const html = await Bun.file(join(root, 'build/assets/mushi/index.html')).text();
    return new Response(html.replace('<script src="/app.js" defer>', '<script src="/fixture.js" defer></script><script src="/app.js" defer>'), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  }
  if (['/app.js', '/style.css', '/mushi.svg'].includes(path)) return new Response(Bun.file(join(root, 'build/assets/mushi', path.slice(1))), { headers: { 'Cache-Control': 'no-store' } });
  return new Response('Not found', { status: 404 });
} });
console.log(`Manual preview: ${server.url}`);
