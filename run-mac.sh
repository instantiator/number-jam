#!/usr/bin/env bash
# Launch number-jam on macOS.
# Prerequisites: Node.js, npm, openalpr (brew install openalpr).
# Run scripts/install-mac.sh if you haven't already.
set -euo pipefail

cd "$(dirname "$0")"

npm run build >&2

node dist/cli.js "$@"
