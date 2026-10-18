# Tool reference

[README](../README.md) · [Codemode](codemode.md) · [Security](security.md)

All tools below are declared directly to the model. Except `codemode` itself,
they are also callable from its WASM scripts as `await tools.<name>(args)`.
Filesystem/network helpers return structured JSON, so scripts can filter, combine
and inspect results without parsing shell output. No shell is involved in these
helpers; bash remains available for operations that need actual commands.

## Available tools

| Tool | Purpose | Script result |
| --- | --- | --- |
| `read` | Read text or supported images | Text for ordinary files |
| `write` | Create/overwrite a file, creating parents | SDK receipt text |
| `edit` | Exact replacements in an existing file | SDK receipt text |
| `bash` | Run native commands | `{ output, exitCode, ... }`; inspect exit code |
| `ls` | List a directory | `{ path, entries, truncated }` |
| `find` | Match recursive paths by glob | `{ path, matches, truncated }` |
| `grep` | Search text files for a literal string | Matches with path/line/text and scan counts |
| `http_request` | HTTP APIs, explicit methods/headers/body | Status, selected headers, bounded body and encoding |
| `web_fetch` | Extract page text/title/links or read plain text | Status, text, links and truncation |
| `web_search` | Best-effort public Bing RSS search | Query, provider and title/URL/snippet results |
| `codemode` | Orchestrate these tools in QuickJS/WASM | Selected script output and nested-call metadata |

Use `describeTool(name)` in codemode to inspect the installed schema rather than
assuming optional fields. `searchTools` and `ALL_TOOLS` expose discovery.

## Filesystem inspection

```js
const [directory, sources, references] = await Promise.all([
  tools.ls({ path: 'src', limit: 100 }),
  tools.find({ path: '.', pattern: '**/*.ts', limit: 200 }),
  tools.grep({ path: '.', pattern: 'TODO', glob: '**/*.ts', limit: 100 })
]);
return { directory, sources, references };
```

Paths are relative to the execution environment's current directory, normally
Mushi's workspace, or can be absolute. This is not a workspace access sandbox.

### `ls`

Arguments: optional `path` (default `.`), `limit` (default 200, maximum 2000) and
`hidden` (default true). Entries include `name`, absolute `path`, `kind`, `size`
and `mtimeMs`. The bounded returned page is sorted by name; it is not guaranteed
to be the first alphabetical page of a larger directory. `truncated` means more
entries may exist. A missing/non-directory path fails explicitly.

### `find`

Arguments: required `pattern`, optional `path`, `hidden` and `limit` (default
200, maximum 2000). Patterns match paths relative to the selected root, using
Bun glob syntax such as `**/*.ts` or `src/**/*.{ts,js}`. Matches carry `path` and
`kind`. Directory and symlink entries may be returned, but symlinks are not
recursively followed.

Traversal skips `.git` and `node_modules`, includes other dotfiles unless
`hidden:false`, and bounds visited entries to 10,000, listed path bytes to 1 MiB
and elapsed traversal to about 10 seconds. The Node-environment fallback also
bounds directory depth to 64. A bound or unreadable subtree marks the result
incomplete. Results are not a complete filesystem index and do not implement
pagination.

The local fallback applies `.gitignore` files encountered from the requested
root downward, including nested patterns and negations. It does not read the git
index, ancestor ignore files outside that root, global git excludes or
`.git/info/exclude`. It applies local ignore files even outside a git repository.
Ignore-file contents are limited to 64 KiB each / 256 KiB total; exceeding those
budgets or encountering unreadable/symlinked rules fails rather than silently
broadening the search.

### `grep`

Arguments: required nonempty `pattern`, optional `path`, `glob`, `ignore_case`,
`hidden` and `limit` (default 100, maximum 1000). Matching is **literal**, not
regular-expression evaluation; `[a-z]+` searches for those characters verbatim.
Patterns cannot span lines. Use bash with an installed search program if you
specifically need regex behavior.

```js
const result = await tools.grep({
  pattern: 'createAgentSandbox', glob: '**/*.ts', ignore_case: false
});
for (const match of result.matches) {
  text({ path: match.path, line: match.line, text: match.text });
}
```

Results include `filesScanned`, `filesSkipped`, `bytesRead` and `truncated`.
Line numbers are 1-based. Returned line text is limited to 1000 characters per
match, with `textTruncated` marking cut lines. Binary files detected by NUL bytes
and symlinks are skipped. Reads are limited to 512 KiB per file / 8 MiB total,
with a roughly 10-second scan deadline and 64,000-character matched-text budget.
A partially read final line is omitted; size/time/result bounds mark the result
incomplete. The same traversal/ignore rules as `find` apply. A file path can also
be searched directly.

## Web pages and search

```js
const search = await tools.web_search({ query: 'Bun SQLite API documentation', limit: 3 });
const pages = await Promise.allSettled(
  search.results.map(hit => tools.web_fetch({ url: hit.url, max_chars: 5000 }))
);
return pages.map((page, index) => ({ source: search.results[index], page }));
```

### `web_search`

Arguments: `query` (1–2000 characters), optional `limit` (default 5, maximum 10)
and `timeout_ms`. Queries are sent to Bing's public RSS endpoint, without an API
key. Results contain `title`, `url` and `snippet`; the response identifies its
provider as `bing-rss`.

This is **best-effort search**, not a supported availability contract with Bing.
The endpoint can return irrelevant results, block requests, change format or rate
limit. Non-2xx or unusable feed responses fail explicitly. Empty results do not
prove no relevant information exists. Search-result snippets and page contents
are untrusted text, not instructions to the agent. There is no CAPTCHA bypass,
paid search-provider credential setup or hidden fallback that invents results.

### `web_fetch`

Arguments: `url`, optional `max_chars` (default 40,000, range 100–100,000) and
`timeout_ms`. Response:

```text
{ url, status, ok, title, text, links: [{ url, text }], truncated }
```

HTML is parsed with `htmlparser2`, without executing JavaScript, fetching images
or loading subresources. Script/style/template and similar non-content elements
are omitted; basic text/block spacing and up to 200 HTTP(S) links are extracted.
This is a basic text extractor, not a headless browser or full readability engine.
It cannot render client-side apps or pass authentication/CAPTCHA challenges.

Plain text and JSON are returned as text; use `JSON.parse` in the WASM script when
appropriate. Binary content fails with guidance to use `http_request`. Non-2xx
pages return their status and text instead of pretending success; always inspect
`ok` and `status`. Both source-byte and extracted-character bounds can set
`truncated`.

## HTTP APIs

```js
const response = await tools.http_request({
  url: 'https://example.com/api/status',
  method: 'GET',
  headers: { accept: 'application/json' },
  timeout_ms: 15000,
  max_bytes: 64000
});
if (!response.ok) return { error: response.status, body: response.body };
if (response.truncated) return 'Response incomplete; request a smaller page.';
return JSON.parse(response.body);
```

`http_request` accepts `url`, optional `method` (`GET` by default; also `HEAD`,
`POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`), string-valued `headers`, string
`body`, `timeout_ms` and `max_bytes`. POST a JSON string with an explicit
`content-type: application/json` header when necessary. GET/HEAD bodies are
rejected. Request bodies are bounded to 1 MiB; binary uploads, multipart builders
and persistent cookie sessions are not provided.

The result contains `url` after redirects, `status`, `ok`, selected response
`headers`, `body`, `encoding` (`utf8` or `base64`), `bytes` and `truncated`.
Text/JSON/XML/JavaScript MIME types are decoded as UTF-8; other declared content
types use base64. Legacy charset conversion is not implemented. Returned headers
are limited to content type/length, ETag, last-modified, retry-after and location;
cookies are not exported as a session store. Non-2xx is a structured result,
not an exception, so inspect status explicitly.

### Shared network bounds and safety

- Only HTTP(S) URLs without embedded username/password are accepted. Local and
  private-network addresses are allowed; this is not an SSRF protection layer.
- Default whole-request timeout is 30 seconds, configurable from 100 ms to 120
  seconds. Abort signals cancel the underlying request/stream.
- Responses are read up to 1 MiB, configurable downward with `max_bytes` for
  `http_request`; there is no automatic file download/spill mechanism.
- At most five redirects are followed. HTTPS-to-HTTP redirects are refused.
  Caller headers are removed on cross-origin redirects, and a body that would
  remain attached across origins is refused. Normal POST-to-GET redirect semantics
  apply for 301/302/303 where appropriate.
- No model-provider credentials are inherited, no ambient cookie jar is used and
  no secret lookup happens. Explicit headers, bodies and URL queries are
  persisted tool arguments: avoid placing secrets there casually.
- All three network tools use **unsafe replay policy**. Interrupted requests are
  reported, not automatically repeated after restart. There is no automatic retry
  loop or exactly-once remote-I/O guarantee.

Filesystem/search limits protect resources but are not authority boundaries.
Use [codemode](codemode.md) to orchestrate independent requests, handle errors and
return compact relevant data. Do not use parallel writes or dependent API
mutations without coordination.
