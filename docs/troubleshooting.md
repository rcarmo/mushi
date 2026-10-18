# Troubleshooting

[README](../README.md) · [Getting started](getting-started.md) · [Build guide](building.md)

Start with the least destructive check. **Do not clear app data, uninstall,
delete the database or reset the extracted prefix as a routine troubleshooting
step.** Those actions can remove source code, credentials and recovery state.

## Collect useful diagnostics

In Mushi, open **Settings → Advanced → Logs** for a bounded runtime-log tail.
**Terminal** opens the fallback shell when the userland is installed. The main
private locations are:

```text
/data/data/io.carmo.mushi/files/usr/
/data/data/io.carmo.mushi/files/home/.mushi/runtime.log
/data/data/io.carmo.mushi/files/home/.mushi/session.sqlite
/data/data/io.carmo.mushi/files/home/.mushi/workspace/
```

Do not share `auth.json`, full databases or unredacted logs. Record the APK/build,
Android version, provider/model, whether this was a clean install or update, and
the exact action preceding failure. Distinguish a model/provider error from an
Android extraction/startup error.

With an authorized development device, inspect relevant Android logs:

```sh
adb devices -l
adb -s DEVICE_SERIAL logcat -d
```

Filter/redact before sharing: logs can include other apps and sensitive task
output. `run-as io.carmo.mushi` is not available on every device; some kernels
disable it even for debug builds. Do not bypass that device policy.

## Installation and updates

### APK refuses to install

Check the device is ARM64 and API 28+, has free storage and permits installation
from the selected source. Verify the APK signature with `apksigner` and inspect
the actual install error.

`INSTALL_FAILED_UPDATE_INCOMPATIBLE` commonly means a signing-certificate
mismatch. Obtain an update signed with the original key. Uninstalling may let a
new key install, but it erases app-private data; it is not a data-preserving fix.
A newly generated debug key on another machine will not match an existing one.

### Updated APK still has an old native runtime

Agent/UI/worker/WASM assets update through the application startup path, but an
already-extracted `usr` prefix is not automatically replaced by a new bootstrap.
This avoids destructive implicit migration. Identify the installed/runtime
versions before considering a separately planned migration. Reinstalling with
`-r` preserves the old extracted prefix; it is not a native-runtime reset.

## Startup and background work

### “Connecting…” or “Starting…” never becomes Ready

1. Tap **Start**, allow first extraction to finish and keep sufficient free space.
2. Check **Logs** for missing executables, SQLite failures, invalid config or
   credential JSON, or repeated daemon exits.
3. Confirm this is a Mushi package/build, not a renamed stock Termux bootstrap.
4. If logs show a build/packaging issue, verify APK embedded payloads using the
   build guide; a fresh external ZIP does not prove the APK contains it.

`Incomplete Mushi bootstrap` means an expected executable is absent. Mushi does
not fall back to Node or fetch arbitrary replacement binaries. Do not fix this
by copying desktop executables into the prefix.

Malformed private JSON reports a sanitized error rather than echoing the file.
Do not paste its contents into an issue. Preserve files and diagnose their source
instead of deleting them blindly.

### Work stops when the screen closes or after reboot

The foreground service is separate from the WebView, but Android/OEM policies
can still stop it. Check that **Start** enabled recovery and **Stop** was not
used. Reopen Mushi and Start manually after force-stop or OEM restrictions. Check
notification/background/battery settings appropriate to the device. A wake lock
consumes power and does not defeat force-stop or guarantee process survival.

### The daemon keeps restarting

`runtime.log` records exits and backoff. The supervisor waits 2–60 seconds before
reopening committed state. Fix the recurring cause instead of launching a second
agent process against the same database. The inherited `owner.lock` deliberately
prevents competing production owners. A leftover lock *file* alone does not mean
a live lock is held; do not delete it to bypass ownership.

## Authentication and models

### Device code expired, browser approval completed too late, or app restarted

Cancel/start a new attempt and use its new code. Pending device grants are
memory-only and cannot resume after process death. Completed credentials persist.
Use the displayed exact provider verification page, not an alternate callback URL.
OpenAI account settings may need device login enabled.

### Signed in, but model is unavailable

Choose an account-enabled model and press **Save model**. Copilot's list is
filtered after authentication. API catalog entries do not guarantee entitlement
or quota. OpenAI API access, ChatGPT/Codex subscription access and Copilot access
are distinct. A subscription credential does not automatically authorize
classifier/image APIs or API-key billing.

### “Abort the active run before changing authentication/settings”

Use **Abort run**, wait for tasks to settle, then retry. The restriction prevents
provider/config mutations from racing active harness work. Finish or cancel a
pending device sign-in before submitting a new task or saving model settings.

### Copilot works but git clone/push fails

Copilot login grants model access, not git repository credentials. Configure an
appropriate repository authentication method separately without putting tokens
in prompts, command history or shared logs. Mushi does not bundle a repository
credential setup UI.

## Tools and codemode

### A program or interpreter is missing

The shipped runtime is a reviewed minimal package closure, not arbitrary Termux.
Use structured `find`/`grep` tools rather than assuming ripgrep is installed;
use Bun rather than Node/npm. Do not expect `pkg` to install replacements: remote
package management and target maintainer scripts are intentionally disabled.
Adding a native program is a lock, relocation and runtime-test change.

A script with a Linux/stock-Termux shebang may refer to a nonexistent interpreter.
Invoke an installed interpreter explicitly, for example `bash script.sh` or
`bun script.ts`. Android Bionic binaries and desktop glibc binaries are not
interchangeable.

### The model does not use codemode

The tool is declared alongside `read`, `write`, `edit` and `bash`; the model can
still choose direct calls. Ask for parallel inspection or output filtering to
make a useful codemode task. Check the [wiring](../agent/harness.ts) and run
`bun test test/codemode.test.ts` if developing. A tool declaration does not force
a live model to choose it. An old running daemon may require reopening the
updated enabled app or Stop/Start to load the new bundle.

### Worker missing, QuickJS fails to load, or script reports a sandbox failure

The bundled `agent.mjs` must have `codemode-worker.mjs` and `quickjs.wasm` as
siblings. Rebuild with `bun run build`, ensure all three assets are inside the
APK and installed by `MushiActivity`, and repeat actual Android Bun smoke tests.
Do not rely on the SDK's default package-relative lookup in a single-file bundle.

### `process`, `fetch`, imports or timers are unavailable

Expected: script bodies run in isolated QuickJS, not host Bun. Use
`tools.http_request`, `tools.web_fetch` and `tools.web_search` for network data;
`tools.ls/find/grep` for inspection; and `tools.read/write/edit` for files.
Bash remains available for commands not covered by structured tools.
`models.*` only accesses registered providers.
See [Codemode](codemode.md) for source format and examples.

### Script says it succeeded but a command failed

Bash can resolve a structured nonzero result. Inspect `exitCode`; do not assume
that `await tools.bash(...)` only resolves on success. Filtered codemode output
can omit details, while expanded nested tool cards retain failure status.

### Too many scripts, out-of-memory or timeout

Each VM has a 128 MiB allocation limit and a five-minute default deadline. At
most four workers are admitted until their actual exit. Reduce data retained in
a script, filter/chunk large reads and avoid unbounded loops. A deliberate SDK
`@options` line can set a task-appropriate timeout/output budget. Limits protect
the host; raising them blindly is not a repair.

### Classifier/image lists are empty

The helper APIs are exposed, but only registered, authenticated compatible
providers can answer them. Current login choices do not supply an image provider.
Do not invent a model ID or assume a chat subscription enables non-chat APIs.

### Recovery reports an interrupted effect or incompatible replay

Completed nested calls are journaled, but an unsafe in-flight operation can have
an ambiguous external outcome. Inspect files/remotes before retrying. SDK/VM
updates can change replay fingerprints, and explicit deadlines can expire.
Do not delete journals to force silent re-execution. No exactly-once external
I/O or automatic rollback is promised.

## Build and test problems

| Symptom | Check |
| --- | --- |
| Locked archive returns 404 | Preserve failure; intentionally refresh/review the lock rather than downloading an unpinned replacement |
| GPG/index/archive hash failure | Stop and investigate metadata/cache/network integrity; never disable verification |
| AAPT2/NDK “Exec format error” on ARM64 host | Use native ARM64 host tools and the narrow NDK adapter, not QEMU |
| Missing NDK/JDK/platform | Match `JAVA_HOME`, SDK directories and selected `JITPACK_NDK_VERSION` to the build guide |
| APK verification detects stale bootstrap | Regenerate/stage native inputs and rebuild; inspect the ZIP embedded inside the APK's library |
| Source edit disappears after prepare | Edit root `android/` overlays/scripts, not `build/android/termux-app/` |
| Bundled-server test disagrees with source | Run `bun run build` before `bun test` |
| Native smoke refuses host architecture/prefix | It requires deliberately provisioned Linux ARM64/Bionic and exact candidate paths; do not bypass the checks |

For reproducible reports, include the exact command, redacted error, lock/hash,
host architecture and whether the failing process was host Bun, Android Bun on
Linux/Bionic, or the Android application on a device.
