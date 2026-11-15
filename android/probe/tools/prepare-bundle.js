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
 *   3. mineflayer's default `version: false` opens the handshake with the
 *      NEWEST known version before the server tells it anything, so the newest
 *      data directory has to survive too.
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

function dirsFor (version) {
  const entry = dataPaths.pc[version]
  if (!entry) throw new Error(`minecraft-data has no pc dataPaths for ${version}`)
  return Object.values(entry)
}

// Everything the two reachable versions point at, plus the always-required commons.
const keep = new Set(['pc/common', 'bedrock/common'])
for (const version of [MC_VERSION, newest]) {
  for (const dir of dirsFor(version)) keep.add(dir)
}

for (const family of ['pc', 'bedrock']) {
  const base = path.join(dataRoot, family)
  if (!fs.existsSync(base)) continue
  for (const name of fs.readdirSync(base)) {
    const rel = `${family}/${name}`
    if (rel === `${family}/common`) continue
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
  // Building a serializer is what createBot does first; it compiles protodef.
  createSerializer({ version, state: 'play' })
  console.log(`ok  ${version} (blocks=${data.blocksArray.length}, protocol=${data.version.version})`)
}

console.log(`ok  mineflayer ${require(path.join(OUT, 'node_modules/mineflayer/package.json')).version} loads`)
console.log(`pruned to: ${[...keep].sort().join(' ')}`)
