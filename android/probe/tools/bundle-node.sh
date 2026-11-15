#!/usr/bin/env bash
# Builds the node bundle that ships as assets/node.zip (one per APK; the probe
# and the app each have their own, they are never merged into one APK).
#
# Usage: bundle-node.sh <repo root> <out dir> [minecraft version] [app|probe]
#
# The only non-obvious part is pruning minecraft-data: the package ships every
# Minecraft version (PC 499 MB + Bedrock 395 MB) while a bot connects to one.
# Pruning is dataPaths-driven, not name-driven, and it verifies the result --
# see tools/prepare-bundle.js for the bugs that made the first device runs fail
# at require() and at createBot().
set -euo pipefail

REPO_ROOT="${1:?repo root}"
OUT="${2:?output dir}"
MC_VERSION="${3:-1.20.1}"
MODE="${4:-probe}"

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$OUT/"

cd "$OUT"
npm ci --omit=dev --no-audit --no-fund

# Prune + prove it still loads and can build a serializer for every version.
# Fails the build if the tree cannot serve a connection, so a broken bundle
# never reaches a phone.
node "$REPO_ROOT/android/probe/tools/prepare-bundle.js" "$OUT" "$MC_VERSION"

if [ "$MODE" = "app" ]; then
  # The real product: bot core + the M1 web UI (the bridge serves it from
  # <bundle>/web) + the libnode entry point.
  cp -r "$REPO_ROOT/src" "$OUT/src"
  cp -r "$REPO_ROOT/web" "$OUT/web"
  cp "$REPO_ROOT/android/app/src/main/js/entry.js" "$OUT/entry.js"
else
  cp "$REPO_ROOT/android/probe/src/main/js/probe.js" "$OUT/probe.js"
fi

{
  echo "bundle: $MODE ($MC_VERSION)"
  du -sh "$OUT"
  du -sh "$OUT/node_modules/minecraft-data" 2>/dev/null || true
  find "$OUT" -type f | wc -l
} > "$OUT/BUNDLE_INFO.txt"

cat "$OUT/BUNDLE_INFO.txt"
