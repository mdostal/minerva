#!/usr/bin/env bash
# Minerva one-command installer.
#
#   curl -fsSL https://mdostal.github.io/minerva/install.sh | bash
#
# This is the CANONICAL copy -- it lives in the repo at scripts/install.sh and gets published
# as-is to the gh-pages site root. If you're editing the published copy directly, edit here
# instead and re-publish.
#
# Installs the CLI + MCP server, then wires it into whatever AI coding agent CLIs are already on
# this machine (Claude Code, Codex CLI today) -- `minerva agent init` owns that part and is
# idempotent, safe to re-run.
#
# npm's existing "minerva" is an unrelated, unmaintained package (an old data-visualization tool
# at infovizconsulting.com) -- same shape of collision the sibling Pantheon project Portunus hit
# on PyPI, same fix: this installs under package.json's real distribution name,
# `pantheon-minerva`; the installed command is still just `minerva` (package.json's own `bin`
# field maps the command name independently of the package name).
#
# Not yet published to npm -- installs straight from GitHub until a real npm release ships.
set -euo pipefail

REPO="git+https://github.com/mdostal/minerva.git"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node (>=20.19) is required and wasn't found on PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required and wasn't found on PATH." >&2
  exit 1
fi

echo "-- installing pantheon-minerva from GitHub"
npm install --global "$REPO"

if ! command -v minerva >/dev/null 2>&1; then
  echo "error: minerva installed but isn't on PATH. Check npm's global bin dir (npm config get prefix) is on \$PATH and re-run." >&2
  exit 1
fi

echo "-- wiring up any agent CLIs already on this machine"
minerva agent init

echo
echo "Done. 'minerva' is installed and wired into every agent CLI detected above."
echo "Next: 'minerva agent status' any time to see what's registered, or"
echo "      https://github.com/mdostal/minerva#readme for the full picture."
