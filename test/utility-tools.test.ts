import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { extractPage, httpUrl, parseSearchFeed, requestHttp } from '../agent/network-tools.ts';
import { openAgent } from '../agent/harness.ts';
import { utilityToolsSmoke } from './utility-tools-fixture.ts';

test('model and WASM codemode can use structured filesystem, HTTP, page and search tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-tools-'));
  try { expect((await utilityToolsSmoke(directory)).noShell).toBe(true); }
  finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);

test('HTTP status, binary encoding, limits, redirects, cancellation and timeout are explicit', async () => {
  let seenHeaders: Headers | undefined;
  const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) { seenHeaders = req.headers; return new Response('redirected'); } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/error') return new Response('missing', { status: 404 });
    if (path === '/binary') return new Response(new Uint8Array([0, 255, 42]), { headers: { 'content-type': 'application/octet-stream' } });
    if (path === '/large') return new Response('x'.repeat(10000));
    if (path === '/redirect') return new Response(null, { status: 302, headers: { location: other.url.href } });
    if (path === '/keep-body') return new Response(null, { status: 307, headers: { location: other.url.href } });
    if (path === '/loop') return new Response(null, { status: 302, headers: { location: '/loop' } });
    if (path === '/bad') return new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } });
    if (path === '/slow') return new Promise<Response>(() => {});
    return new Response('ok');
  } });
  const url = (path: string) => new URL(path, server.url).href;
  try {
    expect(await requestHttp({ url: url('/error') })).toMatchObject({ ok: false, status: 404, body: 'missing' });
    expect(await requestHttp({ url: url('/binary') })).toMatchObject({ encoding: 'base64', body: 'AP8q' });
    expect(await requestHttp({ url: url('/large'), max_bytes: 50 })).toMatchObject({ truncated: true, bytes: 50, body: 'x'.repeat(50) });
    expect(await requestHttp({ url: url('/redirect'), headers: { authorization: 'fixture-secret', 'x-custom-token': 'also-secret', cookie: 'session=fixture' } })).toMatchObject({ status: 200, body: 'redirected' });
    expect(seenHeaders?.get('authorization')).toBeNull();
    expect(seenHeaders?.get('x-custom-token')).toBeNull();
    expect(seenHeaders?.get('cookie')).toBeNull();
    await expect(requestHttp({ url: url('/keep-body'), method: 'POST', body: 'secret-body' })).rejects.toThrow('Cross-origin');
    await expect(requestHttp({ url: url('/loop') })).rejects.toThrow('Too many');
    await expect(requestHttp({ url: url('/bad') })).rejects.toThrow('HTTP(S)');
    await expect(requestHttp({ url: url('/slow'), timeout_ms: 100 })).rejects.toThrow();
    const controller = new AbortController();
    const pending = requestHttp({ url: url('/slow') }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
    await expect(requestHttp({ url: url('/'), method: 'GET', body: 'invalid' })).rejects.toThrow('GET/HEAD');
    expect(() => httpUrl('https://user:password@example.com')).toThrow();
    expect(() => httpUrl('file:///etc/passwd')).toThrow();
  } finally { await server.stop(true); await other.stop(true); }
});

test('HTML extraction does not execute/fetch resources and excludes hidden executable content', () => {
  const page = extractPage('<title>A &amp; B</title><script>BAD<script>MORE</script></script><style>CSS</style><template>HIDDEN</template><p>Hello <b>world</b></p><a href="/ok">A link</a><a href="javascript:alert(1)">No</a><img src="https://invalid.test/track">', 'https://example.com/docs');
  expect(page.title).toBe('A & B');
  expect(page.text).toContain('Hello world');
  expect(page.text).not.toContain('BAD'); expect(page.text).not.toContain('CSS'); expect(page.text).not.toContain('HIDDEN');
  expect(page.links).toEqual([{ url: 'https://example.com/ok', text: 'A link' }]);
  expect(extractPage('<p>' + 'a'.repeat(200) + '</p>', 'https://example.com', 100)).toMatchObject({ truncated: true, text: 'a'.repeat(100) });
  expect(() => parseSearchFeed('<html>Access challenge</html>', 5)).toThrow('blocked or rate-limited');
});

test('filesystem tools honor ignore rules, avoid symlinks/binary data, bound output and handle special names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-files-'));
  const workspace = join(directory, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'special:name.txt'), 'literal [a-z]+\nTARGET\n');
  await writeFile(join(workspace, '.hidden'), 'TARGET');
  await writeFile(join(workspace, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(workspace, 'ignored.txt'), 'TARGET');
  await mkdir(join(workspace, 'nested'));
  await writeFile(join(workspace, 'nested/.gitignore'), '*.tmp\n!keep.tmp\n');
  await writeFile(join(workspace, 'nested/skip.tmp'), 'TARGET');
  await writeFile(join(workspace, 'nested/keep.tmp'), 'kept');
  await writeFile(join(workspace, 'binary.dat'), new Uint8Array([0, 84, 65, 82, 71, 69, 84]));
  await writeFile(join(workspace, 'large.txt'), 'x'.repeat(600_000));
  await mkdir(join(workspace, 'node_modules')); await writeFile(join(workspace, 'node_modules/skip.txt'), 'TARGET');
  await symlink(join(workspace, 'special:name.txt'), join(workspace, 'linked.txt'));
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code: `
const found = await tools.find({pattern:'**/*'});
if (found.matches.some(f=>f.path.includes('skip.txt') || f.path==='ignored.txt' || f.path==='nested/skip.tmp') || !found.matches.some(f=>f.path==='nested/keep.tmp')) throw Error('Ignore rules failed');
const exact = await tools.grep({pattern:'[a-z]+'});
if (exact.matches.length !== 1 || exact.matches[0].path !== 'special:name.txt' || exact.matches[0].line !== 1) throw Error('Literal search/symlink handling failed');
const narrow = await tools.grep({pattern:'TARGET',hidden:false});
if (narrow.matches.length !== 1 || narrow.matches[0].line !== 2 || !narrow.truncated || !narrow.filesSkipped) throw Error('Bounds or binary handling failed');
const limited = await tools.ls({limit:1});
if (limited.entries.length !== 1 || !limited.truncated) throw Error('Listing limit ignored');
return 'filesystem-bounds-ok';
` }), { stopReason: 'toolUse' }), fauxAssistantMessage('Done'),
  ]);
  const agent = await openAgent(directory, models, { provider: 'faux', modelId: 'faux-1' });
  try {
    const submission = await agent.conversation.submit({ type: 'input', content: 'Check bounds', requestId: 'bounds' }, ctx);
    await submission.wait(ctx);
    const entries = (await agent.conversation.context(ctx)).entries;
    const results = entries.flatMap(e => e.model ?? []).filter(m => m.role === 'toolResult');
    expect(results.every(m => !m.isError)).toBe(true);
    expect(JSON.stringify(results)).toContain('filesystem-bounds-ok');
  } finally { await agent.close(); await rm(directory, { recursive: true, force: true }); }
});
