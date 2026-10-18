# Architecture

[README](../README.md) · [Build pipeline](building.md) · [Local protocol](protocol.md)

## Components and boundaries

```text
Android application: io.carmo.mushi
│
├─ MushiActivity / local WebView
│    APK HTML, CSS, JS and SVG at https://mushi.invalid
│    restricted MushiNative JSON bridge
│             │
│             └─ Java LocalSocket → ~/.mushi/agent.sock (mode 0600)
│
├─ TermuxService / MushiRuntime / boot receiver
│    AppShell → bash start-agent.sh → inherited flock → Bun agent.mjs
│
└─ App-private files
     usr/                         relocated prebuilt userland
     home/.mushi/
       session.sqlite             durable harness state
       auth.json                  provider credentials
       config.json                selected provider/model, not API keys
       workspace/                 default coding directory
       agent.mjs                  bundled server and SDKs
       codemode-worker.mjs        separate QuickJS worker entry
       quickjs.wasm               pinned dependency's VM module
```

The UI is native-hosted web content, not a browser connected to an exposed HTTP
server. `https://mushi.invalid` is an intercepted asset origin, not a remote
service or DNS dependency. Java forwards allowlisted operations to an HTTP-style
protocol carried over an app-private Unix socket. The production daemon does
not listen on TCP.

The package ID is `io.carmo.mushi`, while Java/JNI names stay under `com.termux`
for upstream binding compatibility. Generated build/extraction paths sometimes
contain `termux-app` or `com.termux`; these are not alternate installed identities.

## Android lifecycle

[`MushiActivity.java`](../android/java/com/termux/app/MushiActivity.java) hosts the
WebView, fixed assets and bridge. Start asks the upstream installer to extract a
missing bootstrap, atomically replaces individual agent assets, creates the
`enabled` marker and starts the foreground service. Changed installed assets
trigger graceful daemon shutdown so the supervisor can reopen with new code.

[`MushiRuntime.java`](../android/java/com/termux/app/MushiRuntime.java) uses the
upstream `AppShell` / `TermuxTask` infrastructure rather than a separate Android
process framework. It checks the supervised task every 30 seconds.
[`MushiBootReceiver.java`](../android/java/com/termux/app/MushiBootReceiver.java)
requests recovery only when the persisted marker exists. Stop removes the marker
and sends shutdown; activity destruction only tears down the UI.

[`start-agent.sh`](../android/start-agent.sh) loads relocated environment defaults,
checks required executables and SQLite compatibility, and acquires an exclusive
nonblocking `flock` on `owner.lock`. The lock FD is inherited by Bun: a surviving
child cannot lose storage ownership merely because its parent shell died.
Abnormal or requested daemon exits while enabled restart with 2–60 second backoff;
a sufficiently long run resets the delay. This mechanism is process supervision,
not protection against Android force-stop or OEM background policy.

## Agent and persistence

[`server.ts`](../agent/server.ts) requires Bun and an explicit `MUSHI_HOME`, opens
credentials and model providers, then opens the durable agent. It validates
requests, serializes most mutations and serves snapshots from the harness watch.
Saving provider/model selection is separate from saving credentials. A legacy
API key in config is migrated into the credential store and removed from config.

[`harness.ts`](../agent/harness.ts) installs the SDK's `CodingTools`, Mushi's
structured filesystem/network tools, the durable codemode extension and Mushi's
prompt sections. A `NodeExecutionEnv` is reused
per working directory, with the relocated bash selected by `PREFIX`. The adapter
name refers to an API, not execution of a Node binary.

`@earendil-works/pi-durable` and Chord own the conversation, task graph, committed
progress, nested calls and recovery journal in SQLite. UI state is a projection
of an immutable committed revision, not another independently written transcript.
Submission request IDs deduplicate admission. That does not make arbitrary shell
commands or remote API operations exactly-once.

Graceful shutdown closes the watch and harness, then the codemode sandbox and
execution environments. The server drains credential mutations and removes the
socket, with a 30-second process shutdown deadline. Recovery preserves pending
work; cancellation and reset have different semantics from shutdown.

## Codemode execution

[`codemode.ts`](../agent/codemode.ts) creates the SDK worker-based sandbox with a
128 MiB QuickJS allocation limit and four-worker admission cap. It bounds durable
`start()` calls to five minutes by default because the SDK's durable-start API,
unlike its ordinary `execute()`, otherwise has no default deadline. A script's
explicit SDK timeout is passed through.

Every script has a fresh QuickJS VM in a Bun worker. A shared interrupt flag lets
spinning WASM terminate without blocking the agent event loop. The VM lacks host
modules, `process` and `fetch`; host effects happen through registered tool calls.
The durable extension journals those calls and replays their results when
resuming. See [Codemode](codemode.md) for the visible API and replay constraints.

Bundled deployments cannot rely on the SDK's package-relative default worker or
WASM paths. [`codemode-assets.ts`](../scripts/codemode-assets.ts) builds the worker
separately and copies `quickjs.wasm` beside `agent.mjs`. The sandbox uses those
siblings when present; source tests resolve installed packages instead. Both APK
assets and Android smoke fixtures use this packaging path.

## Structured filesystem and network tools

[`filesystem-tools.ts`](../agent/filesystem-tools.ts) adds `ls`, glob-based `find`
and literal `grep` through the execution environment's bounded filesystem readers.
The Node environment lacks optional `listFiles()`, so the local fallback walks
without following symlinks and applies `.gitignore` files encountered from the
selected root down. It skips `.git`/`node_modules` and bounds traversal, file reads
and results; it is not a complete git index/global-ignore implementation.

[`network-tools.ts`](../agent/network-tools.ts) adds bounded/cancellable
`http_request`, HTML/text `web_fetch` and public Bing-RSS `web_search` using host
fetch. HTML/feed parsing uses `htmlparser2` without script execution or resource
loading. Tools return structured values to codemode. They do not inherit model
provider credentials or cookies; cross-origin redirects drop all caller headers,
HTTPS downgrades are refused and body-preserving cross-origin redirects fail.
Network tools are unsafe-replay tasks so interrupted external requests are not
silently repeated. See the [tool reference](tools.md) for formats and limits.

## Authentication

[`auth.ts`](../agent/auth.ts) registers OpenAI, Anthropic, Codex and Copilot
providers using the SDK. Its device-login manager exposes public attempt state,
expiry and verification codes, not grants or tokens. It serializes sign-in,
logout and refresh-sensitive operations with the credential store.

[`credentials.ts`](../agent/credentials.ts) validates and detaches credential
objects and serializes file mutations. Updates use a private temporary file,
file sync, atomic rename and directory sync where supported. Cancellation before
admission prevents a mutation; cancellation after refresh starts must not discard
a newly rotated token. Logout waits for earlier admitted writes before deleting
the provider entry. The storage format is internal, not an import/export API.

## UI rendering

- [`app.js`](../web/app.js): bridge requests, polling, authentication UI, stable
  submission outbox and compact status controls.
- [`transcript-model.ts`](../web/transcript-model.ts): projects committed/live
  entries into paired messages and tool calls, including nested activity.
- [`transcript.ts`](../web/transcript.ts): keyed DOM rows and tool disclosures.
  Mounted rows preserve disclosure state, selection and scroll positions.
- [`markdown.ts`](../web/markdown.ts): token-to-DOM Markdown, safe links and code
  blocks; no model-authored `innerHTML`.
- [`code.ts`](../web/code.ts): highlighting, line ranges, copying and bounded
  expansion; [`terminal.ts`](../web/terminal.ts) restricts ANSI interpretation.
- [`ruby.ts`](../web/ruby.ts): narrow text-only Japanese annotations outside code.

Remote images are not fetched. User-followed HTTPS links require native
confirmation. Tool images are described as attachments rather than an arbitrary
remote-image browser. Architecture, storage and durability details belong in
these docs, not repeated in the normal empty state or status line.

## Source and generated trees

| Path | Role |
| --- | --- |
| `agent/`, `web/`, `android/` | Maintained application code and Android overlays |
| `native/` | Runtime lock, relocation and native bridge |
| `scripts/` | Bun/Python build, packaging, preview and verification entrypoints |
| `test/` | Host tests, fake-provider fixtures and actual Android runtime fixtures |
| `vendor/` | Pinned upstream submodules; do not patch generated app behavior here |
| `build/assets/mushi/` | Generated agent, worker, WASM, UI and aggregated notices |
| `build/android/termux-app/` | Generated pristine upstream export plus overlays |
| `build/prebuilt/` | Verified archives, assembled runtime, bootstraps and smoke receipts |

Modify root sources and regenerate outputs. Do not use edits to ignored build
outputs as the final implementation of a feature.
