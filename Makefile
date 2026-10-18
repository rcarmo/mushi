.PHONY: install build lint test check android-prepare preview clean

install:
	git submodule update --init --recursive
	bun install --frozen-lockfile --ignore-scripts

build:
	bun run build

# Static analysis uses TypeScript; no separate style linter is configured.
lint:
	bun run check

test: build
	bun test

check: lint test
	bash -n android/start-agent.sh

android-prepare: build
	bun run android:prepare

# Credential-free fixture UI; rebuild after source edits.
preview: build
	bun scripts/preview-ui.ts

# Removes generated output only, never app data or submodule worktrees.
clean:
	rm -rf build coverage
