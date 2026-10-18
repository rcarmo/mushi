# Mushi

Read README.md and CONTRIBUTING.md before editing; use docs/architecture.md for
source locations and docs/building.md for the Android pipeline.

- Use Bun. `make install` installs pinned dependencies; `make check` bundles,
  type-checks, tests and checks startup shell syntax.
- `make preview` serves credential-free UI fixtures on port 4173. Android builds
  require the SDK/NDK/JDK documented in docs/building.md.
- Termux dependencies in `vendor/` are exact-commit Git submodules. Keep them
  clean; put changes in maintained root overlays. Update gitlinks and matching
  build configuration together. Never auto-follow upstream branches.
- `build/` is generated. Preserve app identity, installed data, pending durable
  work, credentials and dependency locks.
- Host fixtures, Android runtime, APK, device and live-provider checks have
  distinct scopes; report only checks actually performed.
- Do not push or publish without user approval.
