'use strict'
/*
 * Prunes minecraft-data and then proves the pruned tree still loads.
 *
 * Why this exists: the first on-device probe died at `require('mineflayer')`
 * with "Cannot find module .../data/bedrock/common/features.json", and the
 * second died at createBot with ".../pc/26.1/blocks.json". Both were pruning
 * bugs that a plain require could not catch:
 *
 *   1. minecraft-data/lib/supportsFeature.js and index.js require
 *      data/{pc,bedrock}/common/*.json unconditionally.
 *   2. data.js is lazy, but a version's files do not live in its own directory:
 *      dataPaths.json points e.g. 1.20.1 -> pc/1.20 for blocks and pc/1.17 for
 *      attributes. Deleting by version name deletes data another version needs.
 *   3. mineflayer's default `version: false` pings the server first, and the
 *      server chooses the version. The third device run negotiated 1.13 and
 *      died on ".../pc/1.13/blocks.json" -- a keep-set of {target, newest} is
 *      not enough, because any server version can be negotiated.
 *
 * So: keep every pc/* directory (104 MB raw, ~8 MB zipped) and verify that a
 * protocol serializer can be built for EVERY pc version, not just the two we
 * expect to use.
 *
 * Usage: node prepare-bundle.js <bundle dir> <minecraft version>
 */
const fs = require('fs')
const path = require('path')

const OUT = process.argv[2]
const MC_VERSION = process.argv[3] || '1.20.1'
if (!OUT) throw new Error('usage: prepare-bundle.js <bundle dir> <minecraft version>')

const dataRoot = path.join(OUT, 'node_modules/minecraft-data/minecraft-data/data')
const dataPaths = JSON.parse(fs.readFileSync(path.join(dataRoot, 'dataPaths.json'), 'utf8'))

const pcVersions = Object.keys(dataPaths.pc)
const newest = pcVersions[pcVersions.length - 1]

// Keep every pc version: the negotiated version is decided by the server at
// connect time (mineflayer pings first), so there is no "two versions are
// enough" assumption to make. bedrock is only needed for the commons that
// minecraft-data requires unconditionally at load time.
const keep = new Set(['pc/common', 'bedrock/common'])

for (const family of ['pc', 'bedrock']) {
  const base = path.join(dataRoot, family)
  if (!fs.existsSync(base)) continue
  for (const name of fs.readdirSync(base)) {
    const rel = `${family}/${name}`
    if (family === 'pc' || rel === 'bedrock/common') { keep.add(rel); continue }
    if (!keep.has(rel)) fs.rmSync(path.join(base, name), { recursive: true, force: true })
  }
}

// ---- verification: fail the build, not the phone -------------------------

const minecraftData = require(path.join(OUT, 'node_modules/minecraft-data'))
const mineflayer = require(path.join(OUT, 'node_modules/mineflayer'))
const { createSerializer } = require(path.join(OUT, 'node_modules/minecraft-protocol/src/transforms/serializer'))

function touchEveryLazyGetter (version) {
  const data = minecraftData(version)
  if (!data) throw new Error(`minecraft-data returned null for ${version}`)
  for (const key of Object.keys(data)) {
    // Each of these is a lazy getter in data.js; reading it is the actual test.
    // A pruned-away file throws here (require), so no null check is needed --
    // some derived fields (blockMappings on PC) are legitimately undefined.
    try {
      void data[key]
    } catch (e) {
      throw new Error(`minecraft-data ${version}.${key} failed to load: ${e.message}`)
    }
  }
  return data
}

for (const version of [MC_VERSION, newest]) {
  const data = touchEveryLazyGetter(version)
  console.log(`ok  ${version} (blocks=${data.blocksArray.length}, protocol=${data.version.version})`)
}

// The device run negotiated 1.13 on its own. Any pc version can come back from
// the server, so prove every one of them can build a play-state serializer.
// Pre-release aliases (1.10-pre1, ...) are skipped: no server reports them, and
// minecraft-data upstream ships one of them with mismatched protocol data.
const allPc = Object.keys(dataPaths.pc)
const checked = allPc.filter((v) => !/-(pre|rc)\d*$/i.test(v))
const failed = []
for (const version of checked) {
  try {
    createSerializer({ version, state: 'play' })
  } catch (e) {
    failed.push(version + ': ' + String(e.message).split('\n')[0])
  }
}
if (failed.length) {
  throw new Error(`serializer build failed for ${failed.length}/${checked.length} pc versions:\n  ` + failed.join('\n  '))
}
console.log(`ok  serializer builds for ${checked.length}/${allPc.length} pc versions (pre-release aliases skipped)`)

console.log(`ok  mineflayer ${require(path.join(OUT, 'node_modules/mineflayer/package.json')).version} loads`)
console.log(`kept: ${[...keep].sort().join(' ')}`)
