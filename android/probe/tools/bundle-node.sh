#!/usr/bin/env bash
# Builds the node bundle that the probe APK ships as assets/node.zip.
#
# The only non-obvious part is pruning minecraft-data: the package ships every
# Minecraft version (PC 499 MB + Bedrock 395 MB) while the probe connects to
# exactly one. minecraft-data resolves versions through dataPaths.json, so
# removing directories it never asks for is safe and takes the bundle from
# ~900 MB to tens of MB.
set -euo pipefail

REPO_ROOT="${1:?repo root}"
OUT="${2:?output dir}"
MC_VERSION="${3:-1.20.1}"

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$OUT/"

cd "$OUT"
npm ci --omit=dev --no-audit --no-fund

DATA="$OUT/node_modules/minecraft-data/minecraft-data/data"
if [ -d "$DATA" ]; then
  for d in "$DATA"/pc/*/; do
    keep="$(basename "$d")"
    case "$keep" in
      "$MC_VERSION"|common) ;;
      *) rm -rf "$d" ;;
    esac
  done
  rm -rf "$DATA/bedrock"
fi

cp "$REPO_ROOT/android/probe/src/main/js/probe.js" "$OUT/probe.js"

{
  echo "bundle: $MC_VERSION"
  du -sh "$OUT"
  du -sh "$OUT/node_modules/minecraft-data" 2>/dev/null || true
  find "$OUT" -type f | wc -l
} > "$OUT/BUNDLE_INFO.txt"

cat "$OUT/BUNDLE_INFO.txt"
