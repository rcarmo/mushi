# Security and trust model

[README](../README.md) · [Architecture](architecture.md) · [Troubleshooting](troubleshooting.md)

## Primary warning

**Mushi's agent is not sandboxed from its own Android application.** Its shell
and file tools have the app's permissions and can read the app's private files,
including credentials, conversation state and logs. The default workspace and
prompt instructions are conventions, not filesystem access controls.

Only give the agent tasks, repositories and external access you are willing to
trust at that authority level. Source files, build scripts, tool output and
model responses can contain adversarial instructions. Rendering them safely does
not make acting on their instructions safe. There is no implemented per-command
approval gate, container or policy engine around bash.

## Boundaries and non-boundaries

| Mechanism | Protects | Does not protect |
| --- | --- | --- |
| Android package UID | Mushi's normal private files from other ordinary app UIDs | Against Mushi's own tools, root, compromised OS or an authorized debug channel |
| Private Unix socket, mode 0600 | Keeps the daemon off the network and restricts local filesystem access | Not an authenticated remote API or a separate boundary within the app UID |
| Fixed WebView origin and bridge allowlist | Limits loaded content and native operations from the UI | Does not make a coding task harmless |
| Token-to-DOM Markdown/ruby | Avoids executing authored HTML/JS | Does not prevent prompt injection or sensitive text appearing in output |
| QuickJS worker/WASM | Separates script execution from host JS and keeps runaway scripts off the event loop | Does not restrict the authority of callable bash/read/write tools |
| Durable journals and request IDs | Recover committed work and deduplicate admitted inputs | Do not guarantee exactly-once remote operations or roll back effects |
| Signed upstream metadata and archive locks | Authenticate and pin runtime inputs | Do not audit every upstream component or establish universal relocatability |

## Credentials

The daemon stores provider credentials in
`/data/data/io.carmo.mushi/files/home/.mushi/auth.json`, using a mode-0600 file
and private parent directory. The store serializes changes and writes via a
private temporary file, sync and atomic rename. Completed OAuth refresh writes
must survive caller cancellation so a rotated refresh token is not lost.

Credentials are **plaintext app-private data**, not Android Keystore-encrypted.
The ordinary UI status/config APIs do not return tokens. Credentials are not
stored in browser local storage or deliberately exported to the shell environment.
Nevertheless, the agent can read the file through its tools, and pasted secrets
can enter transcripts and logs. Treat exported database/log/workspace snapshots
as potentially sensitive.

The WebView outbox does use local storage for an unacknowledged user message and
its request ID. Do not confuse that message persistence with credential storage.
Do not paste secrets into tasks expecting them to be transient.

Device sign-in exposes only the public user code, expected verification page,
expiry and attempt status. Browser verification is external to the privileged
WebView. The native code validates fixed provider URLs and active attempts.
There is no OAuth callback TCP listener. Cancel prevents late pending-login
writes; sign-out removes local credentials after earlier admitted mutations.
Sign-out is not remote token revocation. Pending device grants do not survive a
process restart; completed stored credentials do.

Copilot login requests the SDK's `read:user` flow for model access, not repository
scopes. Do not assume it authenticates git clones or pushes. API keys and
subscription/device credentials are not interchangeable.

## UI and local transport

The WebView loads only local APK assets at the synthetic
`https://mushi.invalid` origin. File/content access, automatic navigation and
remote content are restricted. The page CSP disables direct network connections;
API calls use the narrow Java bridge and app-private socket. The daemon does not
bind a TCP port. The local manual-preview server is a separate development tool
bound to `127.0.0.1`, not the production agent endpoint.

Model Markdown is constructed from tokens into DOM nodes, not assigned as raw
HTML. Ruby is limited to text-only annotation syntax outside code. Code and
terminal output remain data; ANSI rendering accepts limited styling and strips
OSC and cursor controls. Remote image URLs are not loaded.

Ordinary user-followed links must be HTTPS, lack embedded credentials and use
the default HTTPS port; the native UI asks for confirmation. Device-login browser
links have a separate exact-provider validation path. Clipboard text and bridge
payloads are bounded. These are mitigations, not a claim of a fully audited
renderer or WebView.

## Shell, networking and external effects

The runtime supports useful filesystem, git, build/test and available network
commands, plus [structured HTTP and web tools](tools.md). HTTP tools intentionally
can reach local/private network addresses; there is no SSRF isolation boundary.
They never automatically attach model-provider tokens, drop all caller headers
on cross-origin redirects, reject HTTPS downgrades and refuse forwarding a
preserved request body across origins. Explicit request headers/bodies and URL
queries are persisted tool arguments, so do not use these tools as a secret store. Network access is not restricted to model providers. The UI cannot
execute an arbitrary shell command through a dedicated native bridge route, but
the model's legitimate bash tool can execute commands. Build scripts downloaded
or checked out by the agent execute with the same authority.

Cancellation requests do not undo file edits, git pushes, uploads or deployments.
An unsafe tool interrupted after a remote system accepted its request can have
an ambiguous outcome. Recovery intentionally avoids blindly rerunning such
operations; inspect the external system before retrying. Parallel scripts should
not race writes to the same files or perform dependent external mutations without
coordination.

Codemode model helpers resolve models through the registered catalog, omit
credential headers from script-visible metadata and do not honor arbitrary
script-supplied endpoints for provider credentials. This helper-level protection
does not stop credential access through ordinary app-authorized tools.

## Runtime supply chain

The default runtime comes from the signed Termux repository, with package
versions, archive sizes and SHA-256 fixed in the checked-in lock. An explicit lock
update verifies `InRelease` against pinned keys and authenticates the package
index before resolving dependencies. Package-maintainer scripts are not executed
during assembly, and remote `pkg` installation is disabled in the shipped image.

Relocation is deliberately narrow: text/symlink paths, ELF lookup information
and a small exec-prefix shim. It is not an arbitrary binary-string replacement
strategy. New native tools require review, lock updates and actual Android
runtime tests. Host-only `/system` Bionic test libraries are excluded from APKs.

The application is GPL-3.0-only integration with preserved upstream exceptions
and separate package licenses. [NOTICE.md](../NOTICE.md), aggregated APK notices
and runtime license inventories matter, but notices alone do not satisfy every
corresponding-source obligation when distributing prebuilt packages.

## Data lifecycle and updates

Mushi has its own UID and does not read or migrate other apps' private data.
Android backups are disabled. Clearing app data or uninstalling removes the
workspace, credentials, database and extracted runtime. No supported migration
or backup/restore UI exists. Do not copy a live SQLite database alone while
ignoring WAL state; coherent backup/restore requires separate careful handling.

An update preserves data only with the same package ID and signing certificate.
Agent assets update on opening an enabled install; an extracted native prefix is
not automatically upgraded. VM/SDK changes can invalidate in-flight replay
fingerprints and should be tested explicitly.

The current debug APK is for development. Release-key management, distribution
policy and target-SDK modernization require separate work. Do not use upstream
public test keys or commit private signing material.

## Reporting and verification

When reporting a problem, redact tokens, prompts, repository URLs, account names
and private file contents from logs and screenshots. If no private reporting
channel has been agreed, first request one without publishing the exploit or
credentials in an issue. This repository does not define a dedicated security
email address or response SLA.

Automated fixtures verify protocol, credential and recovery behavior, not a
formal security proof. Live-provider entitlement, user approval, WebView behavior,
OEM battery handling and app-UID restrictions need device-specific validation.
See the explicit [test scopes](testing.md).
