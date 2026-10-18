#!/data/data/io.carmo.mushi/files/usr/bin/bash
set -eu
if [ -f "$PREFIX/etc/mushi/environment.sh" ]; then
  . "$PREFIX/etc/mushi/environment.sh"
fi
export MUSHI_HOME="$HOME/.mushi"
export TMPDIR="$PREFIX/tmp"
umask 077
mkdir -p "$MUSHI_HOME" "$TMPDIR"
# Inherit the exclusive owner FD so a surviving runtime keeps SQLite ownership.
exec 9>"$MUSHI_HOME/owner.lock"
flock -n 9 || exit 0
exec >>"$MUSHI_HOME/runtime.log" 2>&1
export PATH="$PREFIX/bin:/system/bin"
for program in bun git flock; do
  if [ ! -x "$PREFIX/bin/$program" ]; then
    echo "Incomplete Mushi bootstrap: missing $program. No Node fallback is used."
    exit 1
  fi
done
"$PREFIX/bin/bun" -e 'if (!process.versions.bun) process.exit(1); const {DatabaseSync}=require("node:sqlite"); new DatabaseSync(":memory:").close();' || {
  echo 'Bundled Bun must support the durable SQLite adapter'; exit 1;
}
echo "Mushi runtime: Bun $("$PREFIX/bin/bun" --version)"
delay=2
while [ -f "$MUSHI_HOME/enabled" ]; do
  started=$SECONDS
  "$PREFIX/bin/bun" "$MUSHI_HOME/agent.mjs" && status=0 || status=$?
  [ -f "$MUSHI_HOME/enabled" ] || exit 0
  echo "Agent exited ($status); reopening committed state in ${delay}s"
  sleep "$delay"
  if (( SECONDS - started > 60 )); then delay=2; elif (( delay < 60 )); then delay=$((delay * 2)); fi
  if (( delay > 60 )); then delay=60; fi
done
