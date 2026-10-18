# Third-party source and licensing

Mushi's Android integration is GPL-3.0-only (see LICENSE). This is a modified
Termux-based app, not an official Termux or Earendil product.

- Termux: https://github.com/termux/termux-app, pinned by .gitmodules + gitlink
  to 8629e632fcb95da272221be327db653fb24befe9. GPL-3.0-only with the exceptions
  described in vendor/termux-app/LICENSE.md and termux-shared/LICENSE.md.
  The terminal emulator/view include Apache-2.0 Android Terminal Emulator code.
- Pi durable, pi-ai and Chord: @earendil-works packages, version 1.3.0,
  https://github.com/earendil-works/pi. MIT; full notice in licenses/pi-MIT.txt.
- Termux userland: prebuilt ARM64 packages from https://packages.termux.dev/apt/termux-main/.
  Exact versions and archive SHA-256 hashes are in native/prebuilt-lock.aarch64.json.
  The shipped JavaScript engine is Bun (no Node package/fallback). The runtime
  and exec bridge target io.carmo.mushi. The snapshot was resolved from a
  SHA-256-verified package index authenticated by
  Termux's pinned repository signing keys. Individual packages retain their own
  notices under $PREFIX/share/doc and share/LICENSES (termux-licenses is bundled).
  Modifications consist of ELF runpath updates, text/symlink prefix relocation,
  environment overrides, disabled Termux-app-specific helpers, and the small
  GPL-3.0-only native/exec-prefix.c compatibility library. No blanket binary-string
  prefix replacement is performed. Relocation reports are included in the runtime.
  Package recipes/source references: https://github.com/termux/termux-packages;
  the source reference is pinned to
  ae877f2c6a2b2318abeb43699d6ec5f619c216a6 in the submodule.
- aosp-libs is used ONLY for host-side Android/Bionic runtime tests. It is not
  packaged in the APK, which uses the Android device's system libraries.
- ARM64 APK host tooling: the optional Android SDK tool build from
  https://github.com/lzhiyong/android-sdk-tools is pinned in
  native/apk-arm64-tools.json. It is a build dependency, not an APK payload.
- Rendering inspiration and streaming Markdown boundary logic adapted from
  https://github.com/rcarmo/kintsugi at d8908dc9062babbd6b6cd6d3de2a65c199b31562.
  Copyright (c) 2026 Lucas Meijer, MIT; full notice in licenses/kintsugi-MIT.txt.
  Mushi does not depend on Kintsugi's web framework/design-system runtime.
- The firefly SVG/adaptive launcher artwork is original Mushi project artwork,
  provided under the project license (no external icon/font dependency).
- Bundled JavaScript dependency license texts are collected at build time into
  build/assets/mushi/THIRD_PARTY_LICENSES.txt and packaged in the APK assets.
  bun.lock pins package versions and integrity hashes.

Modifications to Termux are kept in scripts/prepare-android.py and android/,
not hidden in a binary patch. Distributors must supply the corresponding source,
including the pinned upstream source, overlays, build scripts, corresponding
native package source archives/patches and applicable third-party license notices.
A recipe inventory or a URL alone is not a substitute for distributors' source
availability obligations. Do not distribute builds signed with a public
Termux test key. This project deliberately uses the builder's local debug key.
