# Getting started

[README](../README.md) · [Build from source](building.md) · [Troubleshooting](troubleshooting.md)

## Requirements

- An ARM64 Android device running Android 9 / API 28 or later.
- A Mushi APK from a build you trust. The current reviewed artifact is a debug
  APK, not a Play Store release.
- Internet access and access to a supported model provider. Subscription login
  and API-key billing are different authentication methods.
- Sufficient app-private storage for the extracted runtime, workspaces and
  conversation database. The APK size alone is not the installed storage cost.

Mushi installs as `io.carmo.mushi`, with its own Android UID and app-private
storage. Installing it does not grant access to other apps' private files.

## Install and start

Install the APK through Android's package installer, or use ADB:

```sh
adb devices -l
adb -s DEVICE_SERIAL install -r path/to/mushi.apk
adb -s DEVICE_SERIAL shell am start -n io.carmo.mushi/com.termux.app.MushiActivity
```

Replace `DEVICE_SERIAL` with an authorized device. `-r` preserves an existing
installation's data **if the package ID and signing certificate match**. Do not
uninstall to work around a signing mismatch unless you intend to erase the app's
data; see [update failures](troubleshooting.md#installation-and-updates).

Open Mushi and tap **Start**. Initial startup extracts the bundled userland into
the app's private directory, installs the agent assets and starts the foreground
service. Subsequent starts reuse the extracted runtime. No desktop Node runtime,
remote agent server or separate Termux installation is required.

## Connect a model

Open **Settings**, choose a provider, authenticate, choose a model and press
**Save model**.

| Choice | Authentication | Important distinction |
| --- | --- | --- |
| OpenAI (ChatGPT) | Device-code approval in an external browser | Uses the SDK's Codex flow, not an OpenAI API key; account settings may need device login enabled |
| GitHub Copilot | Device-code approval at GitHub | Requires model access from the signed-in account; does not authenticate git repositories |
| Anthropic | API key | Provider API billing and permissions apply |
| OpenAI API | API key | Separate from ChatGPT subscription login |

For device login, use **Open verification page** and enter the displayed code.
Only the expected provider verification page is accepted. **Copy code** copies
the public code, not a token. Complete approval before the code expires.

**Cancel sign-in** cancels a pending attempt; after process death, start a new
attempt. **Sign out** deletes local provider credentials but does not revoke
remote authorization. Revoke that separately through your provider if needed.
Leaving the API-key field blank when saving keeps an existing key.

Changing models or signing out while a task is active is rejected. Use **Abort
run** first. GitHub's model list is filtered by account access after sign-in;
a catalog entry is not a guarantee of entitlement on every provider.

## Work on a task

Mushi's working directory is:

```text
/data/data/io.carmo.mushi/files/home/.mushi/workspace/
```

Start with a concrete request, for example:

> Create a small Bun project in this workspace, write tests, and run them.

The model can read, write and edit files, execute commands, and orchestrate tools
through [codemode](codemode.md). Structured directory/content search, HTTP APIs,
web search and page extraction are available as [direct tools](tools.md), without
shell scripts. Git, builds and other commands remain available through bash. Commands run with Mushi's app permissions;
review tasks involving deletion, secrets, remote repositories or external effects.
The workspace is a default working directory, **not** a filesystem sandbox.

Use **Settings → Advanced → Terminal** for a fallback shell. This is also where
you can clone a repository with the installed git. Git authentication is separate
from Copilot login; no repository credential manager is configured by Mushi.
The runtime is deliberately limited, so do not assume `pkg`, Python, Node, npm,
ripgrep or arbitrary Linux binaries are installed.

### Conversation controls

- **Send** submits a task using a stable request ID. An unacknowledged message is
  retained in the UI outbox and retried on reconnect rather than given a new ID.
- **Queue follow-up** requests another input after current work.
- **Steer next turn** requests steering input while busy; it is not a synchronous
  interruption of an already-running command.
- **Abort run** requests cancellation. It cannot undo completed file writes or
  remote effects.
- **New context** starts a new model context while retaining stored history; it
  does not delete the workspace or provide a factory reset.
- Expand a tool card to inspect its command/script, output, diffs or nested calls.
  Long output is bounded; expand/copy controls apply to the displayed content.

### Language and formatting

Default instructions ask for Japanese prose, kanji with furigana and separate
unlabeled Hepburn romaji readings. Ask explicitly to use another language.
Commands, code, identifiers and literal tool output are not transliterated.
`{日本語|にほんご}` is rendered as ruby outside code; it is not executable HTML.
Model readings are not guaranteed to be linguistically perfect.

## Background work and stopping

Closing the screen does not stop the foreground agent. A notification and the
Termux-based service keep its lifecycle separate from the WebView. Restart and
boot recovery are opt-in through **Start**; **Stop** removes that opt-in and asks
the agent to close while preserving pending durable work.

Android force-stop, Doze, OEM battery policies, reboot restrictions and device
resource pressure can still suspend or kill work. Wake locks consume battery and
do not guarantee survival. On reopening, tap **Start** if recovery is needed.
Interrupted unsafe operations are reported rather than blindly repeated. Check
external systems before retrying an ambiguous deployment, upload or payment.

## Updates, storage and removal

Install updates with the same signing key. Reopening an enabled installation
copies updated agent, worker and WASM assets and restarts changed code. A new
APK's native bootstrap does **not** automatically replace an already-extracted
prefix; native-runtime migration remains a separate maintenance concern.

Sessions, credentials, logs, workspace and runtime assets are app-private.
Android backups are disabled. There is no supported cross-app migration or
backup/restore UI. Uninstalling Mushi or clearing its Android app data erases
these files. Keep independent copies of valuable source code; do not treat the
conversation database as a source-code backup.

See [Security](security.md) before giving the agent sensitive data, and
[Troubleshooting](troubleshooting.md) for logs and recovery steps.
