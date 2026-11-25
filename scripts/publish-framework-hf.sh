#!/usr/bin/env bash
# Publish the synthetic Framework demo to the Hugging Face Static Space.
#
# 1. Builds dist/framework-demo from the real engine (scripts/build-framework-demo.ts)
#    and refuses to continue if the verification gate finds network calls,
#    secret-like strings, unexpected file types or invalid Space metadata.
# 2. Uploads ONLY that verified directory. Requires `hf auth login` beforehand
#    with a token that has write access to the Space. The token is never read
#    or printed by this script.
#
# Usage: scripts/publish-framework-hf.sh [owner/space]
set -euo pipefail
SPACE="${1:-Takzin1/mimamori-framework-lab}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/framework-demo"

if ! command -v hf >/dev/null 2>&1; then
  echo "hf CLI not found. Install it with: python -m pip install -U huggingface_hub" >&2
  exit 1
fi
if ! hf auth whoami >/dev/null 2>&1; then
  echo "Not logged in to Hugging Face. Run: hf auth login" >&2
  exit 1
fi

(cd "$ROOT" && node scripts/build-framework-demo.ts)

echo "Uploading the verified synthetic demo ($OUT) to spaces/$SPACE"
hf upload "$SPACE" "$OUT" . \
  --repo-type space \
  --commit-message "Publish synthetic Mimamori Framework demo (real engine, in-browser only)"

echo "Uploaded. Open https://huggingface.co/spaces/$SPACE and confirm the page loads"
echo "before reporting it as published (Static Spaces can take a minute to refresh)."
