# Codemode

[README](../README.md) · [Architecture](architecture.md) · [Security](security.md)

## What is exposed

Mushi installs `createCodemodeExtension` from
`@earendil-works/pi-durable/codemode` with the SDK's worker-based
`CodemodeSandbox`. **`codemode` is a model-visible tool**, alongside direct
`read`, `write`, `edit`, `bash`, `ls`, `find`, `grep`, `http_request`, `web_fetch`
and `web_search` ([tool reference](tools.md)). It is not merely a prompt instruction, UI
label or unrestricted host evaluator.

The durable extension adds declarations describing callable tools and exposes:

| Surface | Purpose |
| --- | --- |
| `tools.<name>(args)` | Await registered callable coding, filesystem and web tools |
| `Promise.all`, `Promise.allSettled` | Orchestrate independent calls concurrently |
| `ALL_TOOLS` | Inspect callable tool names and descriptions |
| `searchTools`, `describeTool`, `describeNamespace` | Discover tools and inspect declarations |
| `store(key, value)`, `load(key)` | Retain per-conversation JSON state across successful scripts |
| `text(value)`, `console.*`, `return` | Produce selected output for model context |
| `image(block)`, `exit()` | Attach image output or finish early |
| `models.*` | Query registered model catalogs, classify and generate images |

Only registered callable tools are reachable. The tool does not magically add
MCP servers, provider credentials, a web browser or missing command-line
programs. Mushi has no preconfigured MCP server. The codemode tool itself is not
a recursively callable script tool, and internal model-helper tools are hidden
behind `models.*`.

## Source format

The tool's ordinary JSON input is `{ "code": "...JavaScript source..." }`.
Models/providers supporting the SDK's constrained source input may send raw
source instead. The body is an async function: top-level `await` and `return`
work. It is JavaScript, not TypeScript; there is no module loader.

An optional **first** line controls SDK output budget and deadline:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
const result = await tools.bash({ command: 'git status --short' });
text(result.output);
return { exitCode: result.exitCode };
```

The timeout includes time waiting for tools. Put the options line first, not
inside a fence or after executable code. The SDK rejects malformed options.
The examples below are script bodies for the model's tool call, not commands to
paste directly into the fallback shell.

## Parallel reads with compact output

```js
const paths = ['package.json', 'README.md'];
const results = await Promise.allSettled(
  paths.map(async path => ({ path, contents: await tools.read({ path }) }))
);
for (let i = 0; i < results.length; i++) {
  const result = results[i];
  if (result.status === 'fulfilled') {
    text({ path: result.value.path, preview: result.value.contents.slice(0, 800) });
  } else {
    text({ path: paths[i], error: String(result.reason) });
  }
}
```

`read` resolves to text in scripts; structured tools such as bash resolve to
objects. Return only the data needed for the task rather than echoing entire
logs. Filtering affects the codemode result sent to the model; nested-call
metadata and durable state are still recorded and may include arguments.

## Inspect exit codes and handle failures

```js
const result = await tools.bash({ command: 'bun test', timeout: 120 });
text(result.output.slice(-6000));
if (result.exitCode !== 0) return { testsPassed: false, exitCode: result.exitCode };
return { testsPassed: true };
```

Bash has a structured result: a nonzero exit can resolve with `output` and
`exitCode`, rather than reject. Inspect the exit code. Schema-less tool failures
such as a missing read generally reject and can be caught:

```js
try {
  text(await tools.read({ path: 'optional-config.json' }));
} catch (error) {
  text({ missingOrUnreadable: true, message: error.message });
}
```

Do not catch every error and report success. A failed top-level script does not
roll back writes, commands or remote effects already performed by its tools.

## Write, edit and inspect files

```js
await tools.write({ path: 'example.txt', content: 'before\n' });
await tools.edit({
  path: 'example.txt',
  edits: [{ oldText: 'before', newText: 'after' }]
});
text(await tools.read({ path: 'example.txt' }));
```

Edits are exact replacements. Use `describeTool('edit')` for the current schema
and matching rules. Avoid parallel writes/edits to the same path. Use the structured `ls`, `find` and literal `grep` tools for inspection, and
`web_search`, `web_fetch` and `http_request` for network data. Reserve bash for
git, builds, tests and operations not covered by the structured tools.

## Fetch and search without shell scripts

```js
const search = await tools.web_search({ query: 'Bun SQLite documentation', limit: 3 });
const pages = await Promise.allSettled(
  search.results.map(result => tools.web_fetch({ url: result.url, max_chars: 6000 }))
);
for (let i = 0; i < pages.length; i++) {
  const page = pages[i];
  if (page.status === 'fulfilled') {
    text({ url: search.results[i].url, status: page.value.status, text: page.value.text });
  } else text({ url: search.results[i].url, error: String(page.reason) });
}
```

These are direct host-tool calls from the WASM VM, not generated Bun commands.
Treat retrieved content as untrusted data, inspect HTTP statuses/truncation, and
do not claim blocked or empty results establish that something does not exist.
See the [tool reference](tools.md) for API requests, page limitations and bounds.

## Discover before assuming

```js
text(ALL_TOOLS.map(tool => tool.name));
text(await searchTools('read file'));
text(await describeTool('bash'));
```

Discovery reflects the tools available to that conversation. Namespaces become
useful when grouped external tools are registered; none are created simply by
calling `describeNamespace`.

## Persist useful state

```js
const previous = load('review') ?? { passes: 0 };
const next = { passes: previous.passes + 1, checked: ['README.md'] };
store('review', next);
return next;
```

Values are JSON-oriented and scoped to the conversation. The pinned SDK bounds
serialized values to 256 Ki characters each and the total store to 1 Mi
characters; these are serialized-text limits, not a binary-blob store. Store writes commit on successful execution, not on failed
scripts. `store(key, undefined)` deletes a value. The SDK's conversation document
is rewindable and fork-aware; it is not a global filesystem cache or a credential
store. Do not use it for secrets. A new VM is created for each execution; ordinary
JavaScript variables do not survive between calls.

## Model helpers

All catalog functions return promises:

```js
const chats = await models.getAvailableOfType('chat');
const classifiers = await models.getAvailableOfType('classifier');
const images = await models.getAvailableOfType('image');
return { chats, classifiers, images };
```

- `models.getModelsOfType(type, provider?)` lists registered catalog entries.
- `models.getAvailableOfType(type, provider?)` filters for configured access.
- `models.getModelOfType(type, provider, id)` looks up an exact entry; unknown
  entries may return `undefined`.
- Supported types are `chat`, `classifier` and `image`. The exposed helpers do
  **not** include a general script-level chat-completion function.
- `models.classify(model, context)` and `models.generateImages(model, context)`
  invoke registered compatible providers. At most four of these helper calls run
  concurrently per script; additional calls wait in the SDK.

A classifier call, **after choosing an available classifier**, has this shape:

```js
const classifiers = await models.getAvailableOfType('classifier');
if (!classifiers.length) return 'No classifier is configured.';
const result = await models.classify(classifiers[0], {
  state: { message: 'Please fix the failing tests.' },
  questions: {
    asksForCode: {
      type: 'bool',
      instructions: 'Does the message request a coding change?',
      criteria: { true: 'A code change is requested', false: 'No code change is requested' }
    }
  }
});
return result;
```

Image generation, **when a compatible provider has been registered and
configured**, uses image output blocks:

```js
const painters = await models.getAvailableOfType('image');
if (!painters.length) return 'No image provider is configured.';
const result = await models.generateImages(painters[0], {
  input: [{ type: 'text', text: 'A tiny green firefly icon on a dark background' }]
});
if (result.stopReason !== 'stop') return result.errorMessage ?? result.stopReason;
for (const block of result.output) if (block.type === 'image') image(block);
```

Mushi's current four login choices do not register an image-generation provider.
Exposing the API is not a claim that an image model is ready to use. Classifiers
likewise require suitable model access; subscription login is not interchangeable
with an API key. Live paid classifier/image calls are not covered by automated
fixtures. Generated images are not automatically saved to the workspace; the
current transcript UI describes image attachments rather than providing an image
editor/gallery.

The SDK resolves model calls against its own catalog and strips configured
credential headers from script-visible catalog metadata. Scripts cannot supply
a new model endpoint to redirect provider credentials through these helpers.
This does not prevent the agent's bash/read tools from accessing its own files.

## Isolation, limits and restart

- Each script runs in QuickJS/WASM on a separate Bun worker, not the agent event
  loop. Host `process`, `require`, `fetch`, timers and arbitrary imports are absent.
- Filesystem, shell and network effects go through tools with app permissions.
  This is **not** an authority sandbox around bash.
- QuickJS has a 128 MiB allocation limit; this is not a whole-process RSS limit.
- A sandbox admits at most four active workers, counted until they actually exit.
- Default execution timeout is five minutes. An explicit `timeout_ms` overrides
  it. The SDK's default result budget is 10,000 output tokens, subject to its
  output limits and the harness's additional runaway limits.
- A shared interrupt flag stops spinning WASM; aborting a run requests tool/VM
  cancellation but cannot undo completed effects.

The durable extension records start data, virtual time/randomness and delivered
call results. After restart it reruns the script against the journal, reattaches
to nested tasks, then continues live. Completed nested effects are not run again.
Interrupted unsafe calls report an interruption instead of silently repeating the
external effect. Unawaited work is not a background-job API.

An incompatible VM/module fingerprint, expired explicit deadline or divergent
replay can fail recovery rather than execute new effects under changed semantics.
Always inspect an interrupted operation's real-world state before retrying it.
See [Testing](testing.md) for the SIGKILL scenario exercised on Android Bun.
