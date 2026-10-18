# Testing and verification

[README](../README.md) · [Build guide](building.md) · [Troubleshooting](troubleshooting.md)

## Verification layers

Do not collapse these into one claim of “tested on Android”:

| Layer | What it establishes | What it does not establish |
| --- | --- | --- |
| Host Bun tests | Harness/UI projection/auth logic, build validation and host crash recovery | Android ABI, app UID or live-provider access |
| Bundled daemon test | The built single-file server and private socket behave as expected | WebView/native bridge behavior on a device |
| Actual Android Bun on ARM64 Linux/Bionic | Target Bun binary, Android libraries, bundled worker/WASM, native tools and recovery | Full Android app lifecycle or OEM policy |
| APK payload/signature checks | Correct embedded runtime, identity, hashes and signature integrity | Successful extraction/execution on every device |
| Device install/manual checks | Specific app installation, UI and lifecycle observations | Provider entitlement unless a real account is approved and used |
| Live provider calls | A particular configured account/model works at that time | Every catalog entry or future refresh/entitlement |

## Fast local checks

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run check
bun test
bash -n android/start-agent.sh
```

`bun run test` rebuilds and runs the suite. `bun test` alone does not rebuild
bundled assets. Use Bun throughout; do not substitute host Node/npm.

Target a specific area during development:

```sh
bun test test/codemode.test.ts test/utility-tools.test.ts
bun test test/device-auth.test.ts test/device-auth-lifecycle.test.ts
bun test test/transcript-model.test.ts test/japanese.test.ts
```

The suite currently covers:

- SQLite reopen, stable conversation identity, submission deduplication and
  interrupted generation recovery.
- Actual coding-tool execution and a SIGKILL during unsafe effect intent.
- Model-visible codemode declarations, nested read/write/edit/bash, discovery,
  model-helper availability, parallel orchestration, filtered output, reopened
  store, isolation, timeout/cancellation and healthy subsequent workers.
- Structured filesystem tools, nested `.gitignore`, symlink/binary handling and
  bounds; actual HTTP sockets with status, text/binary, request/response bounds,
  cross-origin header stripping, redirect refusal, timeout/abort; page extraction
  and deterministic search-feed fixtures. These are also called from WASM without
  bash in the Android smoke fixture.
- Private atomic credential persistence, malformed input rejection without
  echoing secrets, legacy config migration and logout races.
- SDK device-login fixtures, public status, refresh rotation, cancellation,
  expiry, fixed verification URLs and Copilot account-model filtering.
- Transcript pairing, partial calls, nested progress, diagnostics, bounded
  rendering helpers, terminal filtering, ruby and communication instructions.
- Android identity/overlay idempotency, bootstrap staging, signed-lock/dependency
  handling, native relocation fixtures, exec-path bridge and stale APK payloads.

Keep provider fixtures deterministic and clearly labeled. A fake provider
requesting a tool proves declaration and execution wiring; it is not evidence
that a live model independently chose that tool. Tests must never require a real
provider secret or display one on failure.

## UI preview and manual checks

```sh
bun run build
bun scripts/preview-ui.ts
```

Open `http://127.0.0.1:4173`. The preview serves fixed local fixtures with a mocked
bridge, no agent and no credentials/model requests. Its conversation and test
counts are design samples, not current verification receipts. Rebuild after UI
changes and stop the development server when finished.

Check narrow/mobile and desktop widths, long paths, read line ranges, edit
diffs, script highlighting, nested tools, failures/interruption, Japanese/ruby,
inline code/fences, tables, copy buttons, expand/collapse and selection stability
during updates. Verify malicious HTML stays inert, remote images do not load and
external links remain confirmation-gated on Android. A browser preview cannot
fully validate Android clipboard, external browser or native bridge behavior.

## Actual Android/Bionic Bun smoke tests

```sh
bun run runtime:smoke -- --https
```

This requires a deliberately provisioned **Linux ARM64** host. It refuses
emulation and does not silently prepare a privileged host environment. The target
runtime, not host Bun, executes the fixtures.

Prerequisites:

1. Assemble the reviewed ARM64 runtime with the build guide.
2. Fetch the lock's host-only Bionic libraries explicitly when needed:
   `bun run runtime:fetch -- --testing-libs`.
3. In an isolated/disposable test environment, provision `/system` with the
   corresponding test-only `aosp-libs` loader/libraries. Their layout must satisfy
   the Android executable interpreter and dependencies.
4. Arrange `/data/data/io.carmo.mushi/files/usr` to resolve to this checkout's
   assembled candidate. The runner verifies the real paths are identical. Its
   home and prefix `tmp` must be writable.

These are privileged absolute host paths. **Do not overwrite an existing
`/system` or `/data` installation** and do not apply a blanket setup command to an
unrelated host. Inspect `scripts/smoke-runtime.ts` and the locked package layout
before provisioning. The project does not provide an automatic safe host-system
installer. `--testing-libs` only fetches archives; it does not install `/system`.

The runner:

- Bundles native-tool/auth fixtures and a separate recovery fixture, and places
  the same codemode worker/WASM siblings next to them.
- Runs the actual Android ARM64 Bun under relocated environment defaults.
- Exercises write/edit/read/bash, git including an exec-based alias, SQLite reopen
  and deduplication, SDK OAuth fixtures, refresh/logout and HTTPS certificates.
- Exercises codemode's tool declarations, script helpers, parallel calls, result
  filtering, persistent store, VM isolation, spinning-WASM timeout and abort.
- SIGKILLs a target Bun process after a completed nested effect and during a
  subsequent unsafe nested effect. Recovery must resume the script without
  repeating either effect.
- Starts the production bundled server and checks its private socket,
  configuration, model/auth catalog and shutdown.

`--https` adds a real HTTPS request to `https://example.com`; without it,
`httpsStatus` is null. OAuth and deterministic search fixtures are mocked even when HTTPS is enabled.
With `--https`, an additional real Bing RSS request records public endpoint status
and parsed result count separately as `publicSearch`; this does not guarantee
result relevance or future provider availability.

Outputs under `build/prebuilt/aarch64/` include `smoke-proof.json`,
`android-smoke.log` and `server-smoke.log`. The receipt intentionally contains
`androidDeviceVerified: false`: Linux/Bionic execution is not a device UI test.
Do not change that field merely because the APK also installed somewhere.

## APK checks

```sh
python3 scripts/verify-apk-runtime.py \
  --apk path/to/mushi.apk \
  --bootstraps build/prebuilt/bootstraps
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose path/to/mushi.apk
```

Also inspect the APK ZIP for `assets/mushi/agent.mjs`,
`assets/mushi/codemode-worker.mjs` and `assets/mushi/quickjs.wasm` after changes
to bundling or installation. A source-test pass cannot catch an omitted runtime
asset by itself.

## Device acceptance checklist

Use an authorized device; do not bypass account approval or expose debug ports
publicly.

1. Install the same-signed update with `adb install -r`; confirm Mushi retains
   its workspace and context.
2. Launch Mushi, Start, confirm initial extraction and Ready state.
3. Check Settings, provider choice, code copy, fixed external verification page,
   cancel/expiry, model save and sign-out. With user-approved credentials, make a
   real model request and distinguish that result from fixture success.
4. Request a harmless coding task and a codemode batch; inspect script and nested
   tool cards and resulting workspace files.
5. Check ruby/romaji, long output, diffs, disclosure state, copy, safe external
   links, Terminal and Logs.
6. Close/reopen the screen during harmless work. Separately test process death,
   reboot and Stop/Start, noting the exact Android/OEM behavior. Do not test
   ambiguous external effects against production systems.
7. Verify no credential tokens appear in UI/API status or shared diagnostics.

Some devices disable `run-as` at the kernel level even for debug packages.
An install can succeed while app-private automated inspection remains unavailable;
do not circumvent that restriction or report it as a runtime pass.

## Recording results

Record commit/source state, host and target Bun versions, runtime lock/bootstrap
hash, APK signature verification, device identity/API level and the exact checks
performed. Do not use fixture transcript screenshots or an install-success line
as proof of live-account functionality. When changing SDK/VM versions, repeat
recovery tests and document any compatibility boundary for pending scripts.
