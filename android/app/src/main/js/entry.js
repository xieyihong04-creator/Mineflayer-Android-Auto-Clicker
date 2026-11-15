'use strict'

/**
 * Entry point for the in-app Node runtime (nodejs-mobile, process `:node`).
 *
 * The bundle is extracted to a directory that is wiped whenever assets/node.zip
 * changes, so nothing persistent may live next to this file. The Android side
 * passes its filesDir as argv[2]; config, logs and the Microsoft token cache go
 * there and survive upgrades.
 *
 * stdout does not reach logcat under nodejs-mobile, so quiet mode is the
 * default: the file logger and the HTTP bridge are the only outputs.
 */

const path = require('node:path')

const stateDir = process.argv[2] || process.env.MCBOT_STATE_DIR || __dirname

process.env.MCBOT_STATE_DIR = stateDir
process.env.MCBOT_CONFIG = process.env.MCBOT_CONFIG || path.join(stateDir, 'config.json')
process.env.MCBOT_QUIET = process.env.MCBOT_QUIET || '1'

// Keep uncaught errors somewhere readable before the process dies: without
// this the :node process disappears and only "restarted" shows up in the UI.
process.on('uncaughtException', (err) => {
  try {
    const fs = require('node:fs')
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true })
    fs.appendFileSync(
      path.join(stateDir, 'logs', 'crash.log'),
      `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`
    )
  } catch {}
  process.exit(1)
})

require('./src/index.js')
