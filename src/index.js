'use strict'

const path = require('node:path')
const { ConfigStore } = require('./config')
const { Logger } = require('./logger')
const { PowerTierController } = require('./power/tier')
const { AndroidSignalSource } = require('./power/sources')
const { BotManager } = require('./bot/manager')
const { BridgeServer } = require('./bridge/server')
const { modeMessage } = require('./bridge/protocol')

const ROOT = path.join(__dirname, '..')
const CONFIG_PATH = process.env.MCBOT_CONFIG || path.join(ROOT, 'config.json')
const POWER_POLL_MS = Number(process.env.MCBOT_POWER_POLL_MS || 10000)

async function main () {
  const configStore = new ConfigStore(CONFIG_PATH)
  let config
  try {
    config = configStore.load()
  } catch (err) {
    console.error(`[fatal] ${err.message}`)
    process.exit(1)
  }

  const logger = new Logger({
    dir: path.join(ROOT, 'logs'),
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
  const source = new AndroidSignalSource()
  let lastMode = tier.mode
  const powerLoop = async () => {
    try {
      const signals = await source.read()
      manager.updatePower(signals)
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
