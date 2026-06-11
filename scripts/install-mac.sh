#!/usr/bin/env bash
# Install macOS prerequisites for number-jam.
# Requires Homebrew (https://brew.sh).
set -euo pipefail

echo "Installing number-jam prerequisites for macOS …"

if ! command -v brew &>/dev/null; then
  echo "Error: Homebrew is not installed. Install it from https://brew.sh first."
  exit 1
fi

# ── Docker (default engine) ────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "  Installing Docker Desktop …"
  brew install --cask docker-desktop
  echo "  Docker Desktop installed. Start it from your Applications folder,"
  echo "  then re-run this script to build the ANPR image."
  exit 0
fi

echo "  Building the number-jam-alpr Docker image …"
docker build -t number-jam-alpr "$(dirname "$0")/../docker"
echo "  Docker image 'number-jam-alpr' built successfully."

# ── fast-alpr (optional alternative engine) ───────────────────────────────
if command -v python3 &>/dev/null; then
  echo "  Python 3 found. Installing fast-alpr (optional engine) …"
  pip3 install --quiet fast-alpr
  echo "  fast-alpr installed."
else
  echo "  Python 3 not found — skipping fast-alpr installation."
  echo "  To use --engine fast-alpr later: brew install python3 && pip3 install fast-alpr"
fi

echo ""
echo "Prerequisites installed. Now run:"
echo "  npm install"
echo "  npm run build"
echo "  ./run-mac.sh -i your-video.mp4"
echo ""
echo "  # Or with the fast-alpr engine:"
echo "  ./run-mac.sh --engine fast-alpr -i your-video.mp4"
