import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openAgent } from '../agent/harness.ts';

/** Real sockets/files/tools, with only the external search feed fixture redirected locally. */
export async function utilityToolsSmoke(directory: string) {
  let posts = 0, declared = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/page') return new Response('<html><head><title>Fixture docs</title><script>DO_NOT_INCLUDE_SCRIPT</script></head><body><h1>Useful tools</h1><p>Read this &amp; that.</p><a href="/api">API docs</a></body></html>', { headers: { 'content-type': 'text/html' } });
    if (path === '/rss') return new Response('<?xml version="1.0"?><rss version="2.0"><channel><title>Search fixture</title><item><title>Fixture docs</title><link>https://example.com/docs</link><description>Useful &amp; structured tools</description></item></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } });
    if (path === '/api' && req.method === 'POST') { posts++; return Response.json({ saved: await req.json() }, { status: 201 }); }
    if (path === '/api') return Response.json({ message: 'network-tools-ok' });
    return new Response('Not found', { status: 404 });
  } });
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    return original(url.startsWith('https://www.bing.com/search?') ? new URL('/rss', server.url) : input, init);
  }) as typeof fetch;
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    context => {
      const offered = context.messages.flatMap(message => message.role === 'system' ? message.toolsAdded ?? [] : []);
      declared = ['codemode', 'ls', 'find', 'grep', 'http_request', 'web_fetch', 'web_search'].every(name => offered.some(tool => tool.name === name));
      return fauxAssistantMessage(fauxToolCall('codemode', { code: `
await tools.write({path:'src/alpha.ts',content:'first\\nUseful TOOL\\nlast\\n'});
await tools.write({path:'src/beta.txt',content:'not a match'});
const [listing, files, matches, page, api, search] = await Promise.all([
  tools.ls({path:'src'}),
  tools.find({pattern:'**/*.ts'}),
  tools.grep({pattern:'useful tool',ignore_case:true,glob:'**/*.ts'}),
  tools.web_fetch({url:${JSON.stringify(new URL('/page', server.url).href)}}),
  tools.http_request({url:${JSON.stringify(new URL('/api', server.url).href)}}),
  tools.web_search({query:'fixture docs'})
]);
if (listing.entries.length !== 2 || !files.matches.some(f=>f.path==='src/alpha.ts')) throw Error('Filesystem listing failed');
if (matches.matches[0]?.line !== 2 || matches.matches[0]?.text !== 'Useful TOOL') throw Error('Structured content search failed');
if (page.title !== 'Fixture docs' || !page.text.includes('Read this & that.') || page.text.includes('DO_NOT_INCLUDE_SCRIPT') || !page.links[0]?.url.endsWith('/api')) throw Error('Page extraction failed');
if (JSON.parse(api.body).message !== 'network-tools-ok' || api.status !== 200) throw Error('HTTP response failed');
if (search.results[0]?.url !== 'https://example.com/docs') throw Error('Search feed failed');
const saved = await tools.http_request({url:${JSON.stringify(new URL('/api', server.url).href)},method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proof:42})});
if (saved.status !== 201 || JSON.parse(saved.body).saved.proof !== 42) throw Error('HTTP mutation failed');
return 'structured-utility-tools-ok';
` }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('Utility tools checked'),
  ]);
  let agent: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    agent = await openAgent(directory, models, { provider: 'faux', modelId: 'faux-1' });
    const submitted = await agent.conversation.submit({ type: 'input', content: 'Exercise structured utilities', requestId: 'utility-tools' }, ctx);
    if ((await submitted.wait(ctx)).status !== 'done' || !declared) throw Error('Structured tools not exposed');
    const history = await agent.conversation.context(ctx);
    const results = history.entries.flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult');
    if (results.some(message => message.isError) || !JSON.stringify(results).includes('structured-utility-tools-ok') || posts !== 1) throw Error('Utility tools failed: ' + JSON.stringify(results));
    return { declared: true, codemodeDirectCalls: true, ls: true, find: true, grep: true, http: true, postOnce: true, webTextAndLinks: true, webSearch: 'local RSS fixture', noShell: true };
  } finally { globalThis.fetch = original; if (agent) await agent.close(); await server.stop(true); }
}
