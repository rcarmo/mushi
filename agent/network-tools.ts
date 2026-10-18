import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Parser, parseFeed } from 'htmlparser2';

const MAX_BODY = 1024 * 1024;
const timeoutSchema = Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000, description: 'Whole-request timeout in milliseconds (default 30000)' }));
const result = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredOutput: JSON.parse(JSON.stringify(value)) });

export function httpUrl(value: string, base?: string) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials');
  return url;
}

/** Bounded, cancellable requests; credentials are explicit, never inherited from provider auth. */
export async function requestHttp(args: {
  url: string; method?: string; headers?: Record<string, string>; body?: string;
  timeout_ms?: number; max_bytes?: number;
}, signal?: AbortSignal) {
  const limit = args.max_bytes ?? MAX_BODY;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BODY) throw new Error('max_bytes must be between 1 and 1048576');
  const timeout = args.timeout_ms ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) throw new Error('timeout_ms must be between 100 and 120000');
  let url = httpUrl(args.url), method = args.method ?? 'GET', body = args.body;
  let headers = new Headers(args.headers);
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new Error('Unsupported HTTP method');
  if (['GET', 'HEAD'].includes(method) && body !== undefined) throw new Error('GET/HEAD cannot have a request body');
  if (body !== undefined && Buffer.byteLength(body) > MAX_BODY) throw new Error('Request body exceeds 1 MiB');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('HTTP request timed out')), timeout);
  let response: Response | undefined;
  // No cookie jar and no auto forwarding of authorization across origins.
  try {
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
      await response.body?.cancel();
      if (redirects >= 5) throw new Error('Too many HTTP redirects');
      const next = httpUrl(location, url.href);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade redirect refused');
      if (next.origin !== url.origin) {
        // Drop all caller headers, not just known secret names. Never forward a
        // potentially sensitive request body to an unrelated redirect target.
        if (body !== undefined && !(response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST'))) throw new Error('Cross-origin redirect with request body refused');
        headers = new Headers();
      }
      if ((response.status === 303 && method !== 'HEAD') || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'; body = undefined; headers.delete('content-type'); headers.delete('content-length');
      }
      url = next;
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0, truncated = false;
    try {
      while (reader) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const remaining = limit - bytes;
        if (chunk.value.length > remaining) { chunks.push(chunk.value.subarray(0, remaining)); bytes += remaining; truncated = true; break; }
        chunks.push(chunk.value); bytes += chunk.value.length;
      }
    } finally { await reader?.cancel().catch(() => {}); }
    const buffer = Buffer.concat(chunks, bytes);
    const contentType = response.headers.get('content-type') ?? '';
    const textual = !contentType || /^(text\/|application\/(json|[^;]+\+json|xml|[^;]+\+xml|javascript|x-www-form-urlencoded))/i.test(contentType);
    const responseHeaders: Record<string, string> = {};
    for (const name of ['content-type', 'content-length', 'etag', 'last-modified', 'retry-after', 'location']) {
      const value = response.headers.get(name); if (value !== null) responseHeaders[name] = value;
    }
    return { url: url.href, status: response.status, ok: response.ok, headers: responseHeaders,
      body: textual ? buffer.toString('utf8') : buffer.toString('base64'), encoding: textual ? 'utf8' : 'base64', bytes, truncated };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Parse without evaluating scripts, fetching resources or constructing executable DOM. */
export function extractPage(source: string, url: string, maxChars = 40_000) {
  const blocks = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'section', 'article', 'blockquote']);
  const ignored = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas']);
  let skipped = 0, titleDepth = 0, title = '', anchor: { url: string; text: string } | undefined;
  const text: string[] = [], links: { url: string; text: string }[] = [];
  const parser = new Parser({
    onopentag(name, attrs) {
      if (skipped || ignored.has(name)) { skipped++; return; }
      if (name === 'title') titleDepth++;
      if (blocks.has(name)) text.push('\n');
      if (name === 'a' && attrs.href && links.length < 200) {
        try { anchor = { url: httpUrl(attrs.href, url).href, text: '' }; } catch { anchor = undefined; }
      }
    },
    ontext(value) {
      if (skipped) return;
      if (titleDepth) title += value;
      else text.push(value);
      if (anchor) anchor.text += value;
    },
    onclosetag(name) {
      if (skipped) { skipped--; return; }
      if (name === 'title') titleDepth = Math.max(0, titleDepth - 1);
      if (name === 'a' && anchor) { links.push({ ...anchor, text: anchor.text.trim().slice(0, 300) }); anchor = undefined; }
      if (blocks.has(name)) text.push('\n');
    },
  }, { decodeEntities: true });
  parser.end(source);
  const plain = text.join('').replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title.trim().slice(0, 500), text: plain.slice(0, maxChars), links, truncated: plain.length > maxChars };
}

export function parseSearchFeed(source: string, limit: number) {
  const feed = parseFeed(source);
  if (!feed) throw new Error('Search provider did not return a usable RSS feed; it may be blocked or rate-limited');
  return feed.items.flatMap(item => {
    if (!item.link) return [];
    try { return [{ title: item.title ?? '', url: httpUrl(item.link).href, snippet: extractPage(item.description ?? '', item.link, 1000).text }]; }
    catch { return []; }
  }).slice(0, limit);
}

export const NetworkTools = defineExtension({ name: 'network', tools: [
  defineTool({
    name: 'http_request',
    description: 'Make a bounded HTTP(S) request directly, without shell scripts. Returns status, selected headers and body (UTF-8 text or base64 binary). Non-2xx responses resolve with ok:false; inspect status. Optional explicit headers/body; never inherits model-provider credentials. May access local/private networks. Do not put secrets in arguments: tool arguments are persisted. Unsafe requests are not automatically replayed after interruption.',
    parameters: Type.Object({ url: Type.String(), method: Type.Optional(Type.Union(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(value => Type.Literal(value)))),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())), body: Type.Optional(Type.String({ maxLength: MAX_BODY })),
      timeout_ms: timeoutSchema, max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BODY })) }),
    structuredOutputSchema: Type.Unknown(), replay: 'unsafe',
    async execute(args, _api, context) { return result(await requestHttp(args, context.abortSignal)); },
  }),
  defineTool({
    name: 'web_fetch', description: 'Fetch a URL and extract readable text, title and links from HTML, or return plain text/JSON. No JS execution, browser, cookies or CAPTCHA bypass. Returns HTTP status and truncation explicitly. Use for documentation/pages, not binary downloads.',
    parameters: Type.Object({ url: Type.String(), max_chars: Type.Optional(Type.Integer({ minimum: 100, maximum: 100_000 })), timeout_ms: timeoutSchema }),
    structuredOutputSchema: Type.Unknown(), replay: 'unsafe',
    async execute(args, _api, context) {
      const response = await requestHttp(args, context.abortSignal);
      if (response.encoding !== 'utf8') throw new Error('This URL returned binary content; use http_request instead');
      const html = /html/i.test(response.headers['content-type'] ?? '') || /^\s*(<!doctype html|<html\b)/i.test(response.body);
      const max = args.max_chars ?? 40_000;
      const page = html ? extractPage(response.body, response.url, max) : { title: '', text: response.body.slice(0, max), links: [], truncated: response.body.length > max };
      return result({ url: response.url, status: response.status, ok: response.ok, ...page, truncated: response.truncated || page.truncated });
    },
  }),
  defineTool({
    name: 'web_search', description: 'Search the public web using Bing RSS, returning titles, URLs and snippets. Best-effort public endpoint: may be blocked, rate-limited or return poor matches. An empty result is not proof nothing exists. Does not fabricate results or bypass access checks. Queries go to Bing; no API key required.',
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 2000 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), timeout_ms: timeoutSchema }),
    structuredOutputSchema: Type.Unknown(), replay: 'unsafe',
    async execute(args, _api, context) {
      const url = new URL('https://www.bing.com/search'); url.searchParams.set('format', 'rss'); url.searchParams.set('q', args.query);
      const response = await requestHttp({ url: url.href, timeout_ms: args.timeout_ms }, context.abortSignal);
      if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}`);
      if (response.truncated) throw new Error('Search response exceeded its byte limit');
      return result({ query: args.query, provider: 'bing-rss', results: parseSearchFeed(response.body, args.limit ?? 5) });
    },
  }),
] });
