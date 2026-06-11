#!/usr/bin/env bash
# Launch number-jam on Linux.
# Prerequisites: Node.js, npm, openalpr (apt-get install openalpr openalpr-utils).
# Run scripts/install-linux.sh if you haven't already.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d dist ]; then
  echo "Building number-jam …"
  npm run build
fi

node dist/cli.js "$@"
