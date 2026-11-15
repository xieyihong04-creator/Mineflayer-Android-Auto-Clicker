'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Ring-buffered logger with a switchable file sink.
 * PRD §4: L1 stops writing logs to disk. The in-memory ring keeps working so
 * the UI can still show what happened after the screen wakes up.
 */
class Logger {
  constructor ({ maxEntries = 500, dir = './logs', fileEnabled = true, mirrorConsole = true } = {}) {
    this.maxEntries = maxEntries
    this.dir = dir
    this.fileEnabled = fileEnabled
    this.mirrorConsole = mirrorConsole
    this.buffer = []
    this.subscribers = new Set()
    this.stream = null
    this.seq = 0
    if (fileEnabled) this.openStream()
  }

  openStream () {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      this.stream = fs.createWriteStream(path.join(this.dir, `bot-${day}.log`), { flags: 'a' })
      this.stream.on('error', () => { this.stream = null })
    } catch {
      this.stream = null
    }
  }

  setFileEnabled (enabled) {
    if (enabled === this.fileEnabled) return
    this.fileEnabled = enabled
    if (enabled) {
      if (!this.stream) this.openStream()
    } else if (this.stream) {
      const stream = this.stream
      this.stream = null
      stream.end()
    }
  }

  subscribe (fn) {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  log (level, msg, extra) {
    const entry = {
      t: 'log',
      seq: ++this.seq,
      ts: Date.now(),
      level,
      msg: String(msg)
    }
    if (extra && typeof extra === 'object') entry.data = extra
    this.buffer.push(entry)
    if (this.buffer.length > this.maxEntries) this.buffer.splice(0, this.buffer.length - this.maxEntries)

    if (this.mirrorConsole) {
      const line = `[${new Date(entry.ts).toISOString()}] ${level.toUpperCase()} ${entry.msg}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }
    if (this.stream) {
      this.stream.write(`${JSON.stringify({ ts: entry.ts, level, msg: entry.msg })}\n`)
    }
    for (const fn of this.subscribers) {
      try {
        fn(entry)
      } catch {}
    }
    return entry
  }

  info (msg, extra) { return this.log('info', msg, extra) }
  warn (msg, extra) { return this.log('warn', msg, extra) }
  error (msg, extra) { return this.log('error', msg, extra) }
  debug (msg, extra) { return this.log('debug', msg, extra) }

  recent (limit = 100) {
    return this.buffer.slice(-limit)
  }
}

module.exports = { Logger }
