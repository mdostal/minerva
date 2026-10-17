#!/usr/bin/env bash
# Prove `npm test` is hermetic: put a tripwire `claude` first on PATH that records every call and
# exits non-zero, run the suite, and fail if anything invoked it. The suite's own stub
# (src/test-cli.ts) must shadow the tripwire; any real-CLI call leaks through to it.
set -euo pipefail

cd "$(dirname "$0")/.."
tripwire_dir="$(mktemp -d)"
trap 'rm -rf "$tripwire_dir"' EXIT
log="$tripwire_dir/calls.log"
: > "$log"

cat > "$tripwire_dir/claude" <<SHIM
#!/bin/sh
echo "claude \$*" >> "$log"
echo "test-hermetic: the real claude CLI was invoked by npm test" >&2
exit 97
SHIM
chmod +x "$tripwire_dir/claude"

env -u MINERVA_TEST_REAL_CLAUDE PATH="$tripwire_dir:$PATH" npm test

if [ -s "$log" ]; then
  echo "test-hermetic: FAIL -- npm test invoked the real claude CLI:" >&2
  cat "$log" >&2
  exit 1
fi
echo "test-hermetic: OK -- zero real claude invocations"
