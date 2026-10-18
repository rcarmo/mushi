# Contributing to Mushi

## Development

```sh
make install
make check
```

Use Bun for host JavaScript tooling and keep dependency updates explicit. See
[building](docs/building.md) for Android prerequisites and dependency pins,
[architecture](docs/architecture.md) for source locations, and
[testing](docs/testing.md) for area-specific checks and device acceptance.

- Keep app identity `io.carmo.mushi` and preserve installed app data, credentials
  and pending durable work. Never reset or silently migrate other apps' data.
- Use the durable SDK and codemode implementation; do not introduce a parallel
  persistence layer, simulated tools or a home-grown evaluator.
- Keep upstream Git submodules clean. Changes belong in root source/overlays,
  never only in `vendor/` or generated `build/` files. Update gitlinks and matching
  build configuration together when reviewing a new upstream commit.
- Keep the locked prebuilt runtime as the normal APK path. Do not add QEMU,
  PRoot or a Node fallback.
- Keep provider tests deterministic and credential-free. Record live-provider,
  Android runtime, APK and device checks separately from host test results.

## Review

Before handoff, run `make check` and the relevant checks from the
[testing guide](docs/testing.md). Update documentation where behaviour changes.
Report exact checks and failures; an install or fixture pass does not establish
live account access or Android lifecycle behaviour.

Preserve the private socket, restricted WebView bridge, safe rendering and
credential redaction. Prompt rules are not a security boundary. Review recovery
semantics when changing SDK/VM versions; external effects are not exactly-once.

Never commit signing keys or login state. Review [security](docs/security.md)
and [third-party obligations](NOTICE.md) before sharing diagnostics or builds.
Private vulnerability reporting starts by agreeing a private channel.
