# Local agent protocol

[README](../README.md) · [Architecture](architecture.md) · [Security](security.md)

This is an **internal app protocol**, not a versioned public remote API. Schema
and durable view types follow the pinned SDK. Production transport is HTTP/1.1
JSON over `$MUSHI_HOME/agent.sock`, with socket mode 0600; there is no TCP bind.
Do not expose it through a network proxy or treat it as a multi-user service.

## Transport and validation

[`agent/server.ts`](../agent/server.ts) is authoritative. It requires Bun,
`MUSHI_HOME` and ownership established by the startup script's lifetime lock.
Most POST mutations are queued in arrival order; shutdown is separate. Reads may
observe a different committed revision than a later mutation.

- Request JSON must be an object, not an array; the body limit is 64 KiB.
- Responses have `Content-Type: application/json`, explicit `Content-Length`,
  `Cache-Control: no-store` and `Connection: close`.
- Ordinary validation/operation failures return HTTP 400 with `{ "error": "..." }`.
- Unknown routes return 404; a closing daemon rejects new work with 503.
- Server request/header deadlines are 30/10 seconds. The native bridge has its
  own bounded socket and payload handling.
- Do not parse error messages as a stable machine-readable error enum.

## Daemon routes

| Method and path | Request | Response / effect |
| --- | --- | --- |
| `GET /api/state` | None | `{ view, configured, authBusy, runtime, model }`; `view` is the committed SDK conversation view |
| `GET /api/models` | None | Array of `{ provider, modelId, name }`; Copilot entries are filtered after account authentication |
| `GET /api/auth` | None | Public provider/login status, never credentials |
| `POST /api/auth/start` | `{ provider }` | Begins supported device login and returns public auth status |
| `POST /api/auth/cancel` | `{ id }` | Cancels the identified pending attempt and returns status |
| `POST /api/auth/logout` | `{ provider }` | Deletes local provider credentials and returns status |
| `POST /api/config` | `{ provider, modelId, apiKey? }` | Validates selected model/access, stores credentials if supplied, configures the conversation; `{ ok: true }` |
| `POST /api/submit` | `{ text, requestId, whenBusy? }` | Admits/deduplicates an input; `{ id }` |
| `POST /api/abort` | `{}` | Requests background conversation cancellation; `{ ok: true }` |
| `POST /api/reset` | `{}` | Resets model context, not workspace/history storage; `{ ok: true }` |
| `POST /api/shutdown` | `{}` | Acknowledges, then gracefully closes the daemon |

Provider IDs are `openai-codex`, `github-copilot`, `anthropic` and `openai`.
Device-login start accepts only the first two. A nonblank API key is rejected
for device providers; a blank field keeps an existing key. Never log config
request bodies.

Authentication changes and model selection require no active harness tasks.
Submitting requires an authenticated available model and no pending device flow.
The daemon's provider/model catalog is not equivalent to a guaranteed entitlement
on every account.

### Stable submissions

```json
{
  "text": "Run the project tests and summarize failures.",
  "requestId": "3fe68a8c-0c47-41dc-a64e-c85cb4d8fa07",
  "whenBusy": "followUp"
}
```

`requestId` must match `[\w-]{1,128}`. Use a stable ID when retrying an
unacknowledged message. Do not mint a fresh ID for a transport retry and expect
harness admission to deduplicate it. `whenBusy`, if present, is `steer` or
`followUp`. Submission acknowledgement means admission, not that a task finished;
observe subsequent committed state for results.

### State and credentials

`runtime` reports engine `bun` and its version; `model` is the selected
`{ provider, modelId }` or null. `configured` checks usable auth and model
availability, not merely whether config exists. The view includes user/model/tool
content and must be treated as potentially sensitive even though status routes
do not intentionally export stored credentials.

Do not build another independent transcript by appending every polled snapshot.
Use the committed identities and projection logic in `web/transcript-model.ts`.
The view and document schemas are SDK-owned and are not a promised export format.

## Native WebView bridge

The fixed APK page calls `MushiNative.postMessage` with a JSON envelope:

```json
{
  "id": "request-123",
  "method": "GET",
  "path": "/api/state"
}
```

An optional `body` object carries POST data. Bridge IDs are restricted to
alphanumeric/hyphen strings, 1–80 characters. Java replies by invoking
`window.mushiReply(id, { value })` or `window.mushiReply(id, { error })` with
JSON-escaped values. The UI maintains request promises and a timeout map.

The bridge only forwards the explicit daemon-route allowlist; `/api/shutdown`
is not exposed to page content and is used by native lifecycle code instead.
It also implements
these local actions in
[`MushiActivity.java`](../android/java/com/termux/app/MushiActivity.java):

| Route | Body / action |
| --- | --- |
| `POST /native/start` | Bootstrap/install assets and request foreground start |
| `POST /native/stop` | Request service stop and remove recovery opt-in |
| `POST /native/terminal` | Open the fallback Termux activity |
| `POST /native/copy-text` | `{ text }`; bounded clipboard copy |
| `POST /native/open-link` | `{ url }`; validate HTTPS and ask for native confirmation |
| `POST /native/auth-browser` | `{ provider }`; open only the active login's exact verification URL |
| `POST /native/auth-copy` | `{ provider }`; copy only an active, unexpired public device code |
| `GET /native/log` | Return `{ text }` containing a bounded runtime-log tail |
| `GET /native/licenses` | Return `{ text }` from packaged third-party notices |

There is no native route accepting arbitrary shell commands or arbitrary file
paths. Native lifecycle acknowledgements do not mean the asynchronous agent is
already Ready; poll state. Login-browser requests recheck the current daemon
login, provider and expiry rather than trusting a URL supplied by page content.

The bridge rejects messages above its size cap; clipboard text is limited to
64K characters, logs to a 16 KiB tail and socket responses to 8 MiB. These limits
are implementation bounds, not a guarantee that model context or display output
can use the same sizes. See the source before depending on exact limits.

## Development clients

The [preview UI](testing.md#ui-preview-and-manual-checks) mocks this bridge; it
is not a second production transport. Host integration tests can open the Unix
socket directly in temporary directories. On Android, access to the socket is
subject to app UID and device debugging restrictions. Do not add a public HTTP
listener merely to make diagnostics convenient.
