'use strict'

const os = require('node:os')

/** Stable-ish fingerprint of non-internal interfaces, used for "网络切换" detection. */
function networkSignature (networkInterfaces = () => os.networkInterfaces()) {
  const ifaces = networkInterfaces() || {}
  const parts = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.internal) continue
      parts.push(`${name}:${addr.address}`)
    }
  }
  return parts.sort().join('|')
}

class NetworkWatcher {
  constructor ({ intervalMs = 5000, onChange = () => {}, networkInterfaces } = {}) {
    this.intervalMs = intervalMs
    this.onChange = onChange
    this.networkInterfaces = networkInterfaces
    this.current = networkSignature(this.networkInterfaces)
    this.timer = null
  }

  start () {
    this.stop()
    this.timer = setInterval(() => this.check(), this.intervalMs)
    if (this.timer.unref) this.timer.unref()
  }

  stop () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  check () {
    const next = networkSignature(this.networkInterfaces)
    if (next === this.current) return false
    const prev = this.current
    this.current = next
    this.onChange(prev, next)
    return true
  }
}

module.exports = { networkSignature, NetworkWatcher }
