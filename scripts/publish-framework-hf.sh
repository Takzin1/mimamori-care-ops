#!/usr/bin/env bash
# Publish only synthetic static demo files. Requires prior 'hf auth login'.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v hf >/dev/null 2>&1; then
  echo "Install huggingface_hub CLI first: python -m pip install -U huggingface_hub" >&2
  exit 1
fi
if [ ! -f "$ROOT/demo/mimamori-framework/index.html" ]; then
  echo "Framework demo missing." >&2
  exit 1
fi
echo "Publishing synthetic demo only. No secrets or production data."
hf upload Takzin1/mimamori-framework-lab "$ROOT/demo/mimamori-framework" . \
  --repo-type space \
  --commit-message "Publish Mimamori Framework synthetic demo"
echo "Open https://huggingface.co/spaces/Takzin1/mimamori-framework-lab"
