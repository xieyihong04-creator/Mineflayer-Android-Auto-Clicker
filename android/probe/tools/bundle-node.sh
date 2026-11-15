#!/usr/bin/env bash
# Builds the node bundle that the probe APK ships as assets/node.zip.
#
# The only non-obvious part is pruning minecraft-data: the package ships every
# Minecraft version (PC 499 MB + Bedrock 395 MB) while the probe connects to
# exactly one. Pruning is dataPaths-driven, not name-driven, and it verifies the
# result -- see tools/prepare-bundle.js for the three bugs that made the first
# two on-device runs fail at require() and at createBot().
set -euo pipefail

REPO_ROOT="${1:?repo root}"
OUT="${2:?output dir}"
MC_VERSION="${3:-1.20.1}"

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$OUT/"

cd "$OUT"
npm ci --omit=dev --no-audit --no-fund

# Prune + prove it still loads (touches every lazy getter for the target and for
# the newest version, and compiles a protodef serializer). Fails the build if
# the tree cannot serve a connection, so a broken bundle never reaches a phone.
node "$REPO_ROOT/android/probe/tools/prepare-bundle.js" "$OUT" "$MC_VERSION"

cp "$REPO_ROOT/android/probe/src/main/js/probe.js" "$OUT/probe.js"

{
  echo "bundle: $MC_VERSION"
  du -sh "$OUT"
  du -sh "$OUT/node_modules/minecraft-data" 2>/dev/null || true
  find "$OUT" -type f | wc -l
} > "$OUT/BUNDLE_INFO.txt"

cat "$OUT/BUNDLE_INFO.txt"
