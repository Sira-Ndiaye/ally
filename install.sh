#!/bin/sh
# Installs Ally on Linux, macOS or Windows (Git Bash):
# dependencies, Claude Code hooks, launcher, start at login. Then starts it.
#   ./install.sh                 install and start
#   ./install.sh --no-autostart  do not start at login
#   ./install.sh --remove        remove hooks, launcher and autostart
set -e
cd "$(dirname "$0")"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=mac ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) echo "Unsupported system: $(uname -s)" >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js $(cat .nvmrc) or newer is required: https://nodejs.org" >&2
  exit 1
fi
# 22.12 is the first release that can load Electron's installer.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'; then
  echo "Node.js 22.12 or newer is required (found $(node -v))." >&2
  exit 1
fi

if [ "$1" = "--remove" ]; then
  exec node bin/cli.js remove
fi

echo "Installing Ally for $os"
npm install --no-fund --no-audit
# Electron 44 fetches its binary on first use, not at npm install: fetch it now.
# It does nothing when the right binary is already there.
fetch_electron() { node node_modules/electron/install.js; }
# node_modules copied from another system keeps its binaries: start over in that case.
if ! fetch_electron || ! node scripts/check-deps.js; then
  rm -rf node_modules
  npm install --no-fund --no-audit
  fetch_electron
  node scripts/check-deps.js
fi
# Hooks, launcher, start at login, Linux sandbox fix, then start: shared with the npm package.
if [ "$1" = "--no-autostart" ]; then
  exec node bin/cli.js setup --no-autostart
fi
exec node bin/cli.js setup
