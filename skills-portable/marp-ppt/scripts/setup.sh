#!/usr/bin/env bash
# One-time setup: verify Node 22+, install engine dependencies, run preflight.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or later is required: https://nodejs.org" >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then
  echo "Node.js 22+ required, found $(node -v)" >&2
  exit 1
fi

(cd engine && npm ci --omit=dev --no-audit --no-fund)

out="${PPTX_OUTPUT_ROOT:-$HOME/.marpppt/artifacts}"
mkdir -p "$out" && chmod 700 "$out"
report="$(cd engine && node scripts/preflight.mjs "$out" || true)"
# LibreOffice is optional (previews only); every other preflight error is blocking.
blocking="$(printf '%s' "$report" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
const errs = (r.issues || []).filter((i) => i.severity === "error" && i.code !== "SOFFICE_MISSING");
for (const i of errs) console.log(`${i.code}: ${i.message} -> ${i.suggestedAction}`);
if ((r.issues || []).some((i) => i.code === "SOFFICE_MISSING")) console.error("Note: LibreOffice (soffice) not found. Decks still render; slide previews are skipped.");
')"
if [ -n "$blocking" ]; then
  echo "$blocking" >&2
  exit 1
fi
echo "MarpPPT ready. Output directory: $out"
