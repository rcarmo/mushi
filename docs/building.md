# Building Mushi

[README](../README.md) · [Testing](testing.md) · [Contributing](../CONTRIBUTING.md)

## Fresh-machine quick start

1. Use a Linux machine with Bun, Git, Python 3, `dpkg-deb`, GnuPG, `patchelf`, archive utilities, make and JDK 21.
2. Install Android SDK platform 36, build-tools 36.0.0 and NDK 29.0.14206865, then set `JAVA_HOME` and `ANDROID_HOME`.
3. Clone with `git clone --recurse-submodules https://github.com/rcarmo/mushi.git`, then `cd mushi`. For an existing checkout, run `git submodule update --init --recursive`.
4. Install JavaScript dependencies with `bun install --frozen-lockfile --ignore-scripts`; host Node/npm are unnecessary.
5. Run `bun run build`, `bun run check` and `bun test`.
6. Set `MUSHI_ARCHITECTURES=aarch64` and `TERMUX_SPLIT_APKS_FOR_DEBUG_BUILDS=0`, then run `bun run android:build`.
7. The pipeline fetches hash-locked Android packages, relocates the runtime, compiles the small native bridge, bundles the agent/UI/QuickJS assets, builds the APK and verifies its embedded bootstrap.
8. On an ARM64 Linux host, additionally configure native ARM64 LLVM/AAPT2 and the [documented NDK adapter](#native-linux-arm64-build-hosts) before building—no QEMU is required.
9. Find the APK under `build/android/termux-app/app/build/outputs/apk/debug/` and install it using `adb install -r path/to/apk`; preserving an existing installation requires the same signing key.

## Supported path

The normal build **downloads verified prebuilt Android userland packages**,
relocates a bounded runtime, compiles a tiny exec-path bridge and the Android
application, and embeds the resulting bootstrap. It does not rebuild Bun, git or
the whole Termux userland from source. It does not run QEMU or PRoot, and it does
not ship a Node fallback.

The reviewed runtime target is `aarch64` / `arm64-v8a`, minimum API 28.
Other architecture identifiers in configuration do not have reviewed runtime locks
or equivalent Android Bun verification.
Compile SDK is 36 and target SDK is 28, intentionally retaining Termux native
execution compatibility. This is not a Play Store-ready target.

## Prerequisites

Use a Linux build host with:

- Bun (CI currently pins host Bun 1.4.2; the bundled Android runtime is Bun 1.4.3).
- Git and initialized submodules.
- Python 3, `dpkg-deb` / `dpkg`, GnuPG, `patchelf`, archive utilities and make.
- JDK 21.
- Android SDK platform 36, build-tools 36.0.0 and an NDK. The ordinary default is
  NDK 29.0.14206865; select another reviewed compatible revision explicitly with
  `JITPACK_NDK_VERSION`.
- Network access on the first build to download SDK, Gradle and pinned packages.

Host JavaScript builds, type checks, tests and dependency installation use **Bun,
not host Node/npm**. Python, JDK/Gradle and native LLVM are separate required tools.
Use sufficient disk space for SDK/NDK, Gradle, package caches and the generated
source workspace; these are much larger than the small app sources.

## Checkout and checks

```sh
git submodule update --init --recursive
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run check
bun test
```

`bun run build` creates `build/assets/mushi/`: `agent.mjs`,
`codemode-worker.mjs`, `quickjs.wasm`, `app.js`, HTML/CSS/SVG, startup script and
aggregated third-party notices. `bun test` tests the current tree but does not
implicitly rebuild these bundles; `bun run test` runs build and then tests.
Build first when validating bundled-daemon behavior.

The Termux repositories are Git submodules under `vendor/`. The parent repository
tracks their URLs in `.gitmodules` and their exact commits as gitlinks; upstream
files and Git history stay in the submodules. No upstream branch is followed
automatically. Do not use `git submodule update --remote` for normal builds.

To update a pin intentionally, check out a reviewed upstream commit in the
submodule, update the matching revision in `scripts/prepare-android.py` (app) or
`native/build-config.json` (packages), and commit the gitlink and configuration
together. Review overlays, notices and tests before accepting a new revision.

`make install` initializes these submodules and installs locked Bun dependencies.
`make check` bundles, type-checks, runs host tests and checks the startup shell.

The pinned upstream revisions are:

| Component | Revision / lock |
| --- | --- |
| Termux app | `8629e632fcb95da272221be327db653fb24befe9` |
| Termux packages | `ae877f2c6a2b2318abeb43699d6ec5f619c216a6` |
| Pi AI / durable / codemode / Chord | Explicit `1.3.0` dependencies plus `bun.lock` |
| Android packages | `native/prebuilt-lock.aarch64.json` |
| Optional ARM64 APK host tools | `native/apk-arm64-tools.json` |

## Build the APK

```sh
export JAVA_HOME=/path/to/jdk21
export ANDROID_HOME=/path/to/android-sdk
# If the SDK tools are not already installed:
sdkmanager 'platforms;android-36' 'build-tools;36.0.0' 'ndk;29.0.14206865'
export MUSHI_ARCHITECTURES=aarch64
export TERMUX_SPLIT_APKS_FOR_DEBUG_BUILDS=0
bun run android:build
```

The entrypoint [`scripts/build-apk.ts`](../scripts/build-apk.ts):

1. Validates JDK/SDK/NDK paths and selected architectures.
2. Builds a missing prebuilt bootstrap, or uses the explicitly supplied one.
3. Stages bootstrap inputs and bundles the agent/UI, worker and WASM.
4. Generates `build/android/termux-app/` from the pinned pristine upstream export
   and root Android overlays, without resetting the vendor working tree.
5. Runs Gradle `assembleDebug` with bounded worker count.
6. Verifies the actual bootstrap embedded in each APK against the manifest.

Default output directory:

```text
build/android/termux-app/app/build/outputs/apk/debug/
```

With universal debug output selected, the current filename is
`termux-app_apt-android-7-debug_universal.apk`. The upstream filename is not the
application ID. Copy/rename the artifact for distribution as desired; copying it
to `build/mushi-arm64-debug.apk` is a convenience, not a separate build step.

## Runtime fetch, assembly and lock updates

```sh
# Download only the runtime packages fixed by the checked-in lock:
bun run runtime:fetch

# Relocate the runtime, compile the exec bridge and create bootstrap artifacts:
NDK=/path/to/ndk bun run runtime:build

# Explicitly refresh package versions, then review the resulting diff:
bun run runtime:fetch -- --refresh-lock
```

Normal fetch verifies archives against locked size and SHA-256. An intentional
lock refresh verifies Termux's `InRelease` with pinned signing keys, checks the
package index against the signed checksum and resolves a minimal dependency
closure. `Depends` and `Pre-Depends` are included; recommendations are not a reason
to add packages. If an old locked archive disappears upstream, the build fails
rather than silently moving to a different version.

[`native/assemble-prebuilt.py`](../native/assemble-prebuilt.py) extracts packages
without running target maintainer scripts, relocates text paths and symlinks,
repairs ELF lookup paths and builds `native/exec-prefix.c`. The bridge redirects
specific demonstrated compiled-in stock-prefix exec paths; it is not universal
binary rewriting or a general Linux compatibility layer. `pkg`, repository app
integration and target package-maintainer scripts are disabled.

Artifacts include:

| Location | Contents |
| --- | --- |
| `build/prebuilt/aarch64/debs/` | Verified archive cache |
| `build/prebuilt/aarch64/assembled/data/data/com.termux/files/usr/` | Host extraction layout; files are relocated for Mushi |
| `build/prebuilt/bootstraps/bootstrap-aarch64.zip` | APK bootstrap payload |
| `build/prebuilt/bootstraps/manifest.json` | Architecture/hash manifest |
| `build/prebuilt/staged/` | Validated bootstrap staging |

The `com.termux` extraction directory is not permission to install under that
identity. Runtime metadata and installed paths must name `io.carmo.mushi`.

### Environment reference

| Variable | Use |
| --- | --- |
| `JAVA_HOME` | JDK 21 root |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | SDK root; APK preflight accepts either |
| `JITPACK_NDK_VERSION` | NDK directory revision used by the Android build |
| `NDK` / `MUSHI_RUNTIME_NDK` | Explicit NDK for runtime bridge assembly |
| `MUSHI_ARCHITECTURES` | Comma-separated APK architectures; reviewed value is `aarch64` |
| `MUSHI_BOOTSTRAP_DIR` | Use a supplied bootstrap directory rather than fetching a missing default |
| `MUSHI_AAPT2` | Override AAPT2 executable for the APK host |
| `MUSHI_RUNTIME_CC`, `MUSHI_RUNTIME_LD` | Native compiler/linker overrides for the small bridge |
| `GRADLE_USER_HOME` | Optional Gradle cache directory |
| `TERMUX_SPLIT_APKS_FOR_DEBUG_BUILDS` | Set `0` for universal debug output |

`MUSHI_HOME` belongs to the running daemon, not the APK build; on Android the
startup script sets it to `$HOME/.mushi`.

## Native Linux ARM64 build hosts

Google's Linux NDK host executables and ordinary AAPT2 downloads are typically
x86-64. Do not introduce an emulator to make them run on ARM64. The project has a
narrow adapter for the application's JNI build using native ARM64 LLVM 21 with
the original NDK's target headers, libraries and compiler runtime:

```sh
python3 native/prepare-arm64-apk-tools.py \
  --ndk /path/to/original-ndk \
  --output /path/to/new-adapted-ndk \
  --llvm /usr/lib/llvm-21
```

The output must be a new directory. The adapter retains an upstream host directory
tag where NDK make scripts expect it, but its executable tools are ARM64 or
fail-closed stubs. It hard-links untouched inputs and avoids modifying them when
writing wrappers. Make the resulting NDK selectable under the SDK and set
`JITPACK_NDK_VERSION` accordingly. Use a native ARM64 AAPT2 via `MUSHI_AAPT2`.
See `native/apk-arm64-tools.json` for the pinned optional APK tool archive.

## Verification, signing and installation

```sh
python3 scripts/verify-apk-runtime.py \
  --apk path/to/mushi.apk \
  --bootstraps build/prebuilt/bootstraps
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose path/to/mushi.apk
adb -s DEVICE_SERIAL install -r path/to/mushi.apk
```

Runtime verification extracts the ZIP inside `libtermux-bootstrap.so`, compares
its exact hash with the selected manifest and checks identity/architecture,
Android Bun presence, absence of a Node fallback and exclusion of host-only
Bionic test libraries. This catches stale native `.incbin` payloads; the mere
existence of a fresh ZIP outside the APK is insufficient.

Debug builds use the local private debug key, not Termux's public untrusted test
key. Existing installs can only update with a matching signing certificate.
There is no turnkey release-signing pipeline in this repository: a production
release requires a private release key, upstream-compatible signing configuration,
artifact verification and compliance review. Never commit signing keys.

## CI

[Android CI](../.github/workflows/android.yml) installs dependencies with Bun,
bundles, type-checks, tests and checks overlay idempotency. Non-pull-request builds
then package and upload the ARM64 debug APK and bootstrap artifacts using the
prebuilt path. CI does not run the privileged ARM64/Bionic smoke environment or
automatically approve live model accounts.

See [Testing](testing.md) for the separate Android runtime verification path.
