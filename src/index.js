'use strict'

// Opt-in protocol tracing, off by default: `MCBOT_DEBUG_PROTOCOL=1 npm start`
// (or DEBUG=minecraft-protocol:* directly). mineflayer/minecraft-protocol read
// DEBUG at require time, so this has to run before the first require.
if (process.env.MCBOT_DEBUG_PROTOCOL === '1' && !process.env.DEBUG) {
  process.env.DEBUG = 'minecraft-protocol:*'
}

const path = require('node:path')
const { ConfigStore } = require('./config')
const { Logger } = require('./logger')
const { PowerTierController } = require('./power/tier')
const { AndroidSignalSource } = require('./power/sources')
const { BotManager } = require('./bot/manager')
const { BridgeServer } = require('./bridge/server')
const { modeMessage } = require('./bridge/protocol')

const ROOT = path.join(__dirname, '..')
// On Android the code lives in assets/node.zip, which is re-extracted whenever
// the bundle changes. Anything that must survive an APK update (config, logs,
// Microsoft tokens) goes to MCBOT_STATE_DIR = the app's filesDir instead.
const STATE_DIR = process.env.MCBOT_STATE_DIR ? path.resolve(process.env.MCBOT_STATE_DIR) : ROOT
const CONFIG_PATH = process.env.MCBOT_CONFIG || path.join(STATE_DIR, 'config.json')
const LOG_DIR = process.env.MCBOT_LOG_DIR || path.join(STATE_DIR, 'logs')
const POWER_POLL_MS = Number(process.env.MCBOT_POWER_POLL_MS || 10000)
// Power telemetry to jsonl normally rides on the 10s poll. For on-device
// measurement runs it has to be off: the script's own 60s probe is then the
// only sampler, so the bot-ON and baseline runs pay the same probe cost.
const POWER_TELEMETRY = process.env.MCBOT_POWER_TELEMETRY !== '0'

async function main () {
  const configStore = new ConfigStore(CONFIG_PATH)
  let config
  try {
    config = configStore.load()
  } catch (err) {
    console.error(`[fatal] ${err.message}`)
    process.exit(1)
  }

  // `profilesFolder: './.auth'` would resolve against the CWD, which is `/` for
  // a process started by Android's libnode. Pin it inside the state dir so the
  // Microsoft token cache is found again after an upgrade.
  if (process.env.MCBOT_STATE_DIR && !path.isAbsolute(config.auth.profilesFolder)) {
    config.auth.profilesFolder = path.join(STATE_DIR, 'auth')
  }

  const logger = new Logger({
    dir: LOG_DIR,
    fileEnabled: config.power.logToFile,
    mirrorConsole: process.env.MCBOT_QUIET !== '1'
  })
  logger.info(`starting mineflayer-android-console v0.1 (node ${process.version})`)

  const tier = new PowerTierController({ config })
  const manager = new BotManager({ configStore, logger, tier })
  tier.onChange = (mode, prev, meta) => manager.applyModeActions(mode, prev, meta)
  manager.start()

  const server = new BridgeServer({
    manager,
    configStore,
    logger,
    webRoot: path.join(ROOT, 'web'),
    host: config.ws.host,
    port: config.ws.port
  })
  try {
    await server.start()
  } catch (err) {
    logger.error(`cannot start bridge on ${config.ws.host}:${config.ws.port}: ${err.message}`)
    process.exit(1)
  }

  // F7 sensor loop: battery / thermal / screen / power-save -> tier machine.
  const source = new AndroidSignalSource({ thermal: config.power.thermal })
  let lastMode = tier.mode
  const powerLoop = async () => {
    try {
      const signals = await source.read()
      manager.updatePower(signals)
      // Numbers, not UI: W, cycles and the full-pack estimate land in
      // logs/power-<day>.jsonl even at L0, where the event log is switched off.
      // Disabled with MCBOT_POWER_TELEMETRY=0 so a measurement run has exactly
      // one sampler (the on-device probe), never two at different intervals.
      if (POWER_TELEMETRY) {
        logger.sample({
          t: 'power',
          mode: tier.mode,
          battery: signals.battery,
          charging: signals.charging,
          powerSave: signals.powerSave,
          thermalC: signals.thermalCelsius,
          thermalBaselineC: signals.thermalBaselineC,
          thermalDelta: signals.thermalDelta,
          thermalZone: signals.thermalZone,
          ...(signals.telemetry || {})
        })
      }
      if (tier.mode !== lastMode) lastMode = tier.mode
      server.broadcast(modeMessage(tier.snapshot))
    } catch (err) {
      logger.debug(`power poll failed: ${err.message}`)
    }
  }
  await powerLoop()
  const powerTimer = setInterval(powerLoop, POWER_POLL_MS)
  if (powerTimer.unref) powerTimer.unref()

  if (config.server.autoConnect && config.server.host) {
    manager.connect()
  } else if (!config.server.host) {
    logger.warn('server.host is empty; configure it from the web UI (http://127.0.0.1:' + config.ws.port + ')')
  }

  const shutdown = async (signal) => {
    logger.info(`shutting down (${signal})`)
    clearInterval(powerTimer)
    manager.destroy()
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (err) => {
    logger.error(`unhandled rejection: ${err && err.message ? err.message : err}`)
  })
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack || err.message}`)
  process.exit(1)
})
