#!/usr/bin/env bash
# Install Linux prerequisites for number-jam.
# Tested on Ubuntu / Debian. Adjust for other distributions as needed.
set -euo pipefail

echo "Installing number-jam prerequisites for Linux …"

# ── Docker (default engine) ────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "  Installing Docker …"
  sudo apt-get update -q
  sudo apt-get install -y docker.io
  sudo systemctl enable --now docker
  echo "  Docker installed."
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
  echo "  To use --engine fast-alpr later: sudo apt-get install python3-pip && pip3 install fast-alpr"
fi

echo ""
echo "Prerequisites installed. Now run:"
echo "  npm install"
echo "  npm run build"
echo "  ./run-linux.sh -i your-video.mp4"
echo ""
echo "  # Or with the fast-alpr engine:"
echo "  ./run-linux.sh --engine fast-alpr -i your-video.mp4"
