'use strict'

/**
 * Server address resolution: `_minecraft._tcp` SRV + A, without trusting c-ares.
 *
 * Two separate problems live here, both found on a real device:
 *
 *   1. minecraft-protocol looks up SRV with `dns.resolveSrv` (c-ares), which is
 *      not reliable under nodejs-mobile on Android. When it silently fails it
 *      falls back to connecting to the A record, which for a TCPShield-fronted
 *      domain is a Cloudflare web address, not the game server.
 *   2. Its tcp_dns module then *overwrites* `options.host` with the SRV target,
 *      so the Minecraft handshake carries `jp.example.net` instead of the
 *      hostname the user typed. TCPShield routes by handshake hostname and
 *      answers "Invalid hostname" (plus a decoy status: protocol 389).
 *
 * So we resolve ourselves - system, then DNS-over-HTTPS - and the caller keeps
 * the typed hostname in the handshake while only the TCP socket goes to the
 * resolved address.
 *
 * `dns.lookup` (getaddrinfo, libc) is used for A records on purpose: unlike the
 * c-ares `resolve*` family it works on Android.
 */

const dns = require('node:dns')
const https = require('node:https')
const net = require('node:net')

const SRV_PREFIX = '_minecraft._tcp.'
const DEFAULT_TIMEOUT_MS = 4000
const DEFAULT_CACHE_MS = 5 * 60 * 1000

const DOH_ENDPOINTS = [
  ['cloudflare', 'https://cloudflare-dns.com/dns-query'],
  ['google', 'https://dns.google/resolve']
]

function defaultHttpJson (url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { accept: 'application/dns-json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`http ${res.statusCode}`))
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

/** DoH JSON -> [{ name, port, priority, weight }] (SRV data is "prio weight port target"). */
function parseDohSrv (json) {
  const out = []
  const answers = (json && json.Answer) || []
  for (const row of answers) {
    if (row.type !== 33 || typeof row.data !== 'string') continue
    const parts = row.data.trim().split(/\s+/)
    if (parts.length < 4) continue
    const priority = Number(parts[0])
    const weight = Number(parts[1])
    const port = Number(parts[2])
    const name = parts[3].replace(/\.$/, '')
    if (!name || !Number.isFinite(port) || port <= 0) continue
    out.push({ name, port, priority: Number.isFinite(priority) ? priority : 0, weight: Number.isFinite(weight) ? weight : 0 })
  }
  return out
}

/** Lowest priority wins; equal priority -> highest weight (RFC 2782 ordering). */
function pickSrv (records) {
  if (!records || records.length === 0) return null
  return records.slice().sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight))[0]
}

function isDirectHost (host) {
  return !host || host === 'localhost' || net.isIP(host) !== 0
}

function createResolver ({
  dnsModule = dns,
  httpJson = defaultHttpJson,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_MS,
  now = Date.now
} = {}) {
  const cache = new Map()

  const call = (fn, ...args) => new Promise((resolve, reject) => {
    fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
  })

  const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)
    if (timer.unref) timer.unref()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })

  // dns.lookup's callback form is (err, address, family) - not the
  // { address, family } object of dns.promises.lookup.
  const lookupOnce = (host, family) => new Promise((resolve, reject) => {
    dnsModule.lookup(host, { family }, (err, address) => (err ? reject(err) : resolve(address)))
  })

  async function lookupA (host) {
    try {
      const address = await lookupOnce(host, 4)
      if (address) return address
    } catch (err) {
      // No IPv4 record: retry without a family constraint before giving up.
      const address = await lookupOnce(host, 0)
      if (address) return address
      throw err
    }
    throw new Error(`no address for ${host}`)
  }

  /** Returns { records, via } or null when the domain simply has no SRV. */
  async function srvLookup (host) {
    const name = SRV_PREFIX + host
    const attempts = []
    try {
      const rows = await call(dnsModule.resolveSrv, name)
      if (rows && rows.length) return { records: rows, via: 'system' }
      attempts.push('system: empty')
    } catch (err) {
      attempts.push(`system: ${err.code || err.message}`)
    }
    for (const [label, base] of DOH_ENDPOINTS) {
      try {
        const url = `${base}?name=${encodeURIComponent(name)}&type=SRV`
        const json = await withTimeout(httpJson(url, timeoutMs), timeoutMs, label)
        const rows = parseDohSrv(json)
        if (rows.length) return { records: rows, via: label }
        attempts.push(`${label}: empty`)
      } catch (err) {
        attempts.push(`${label}: ${err.message}`)
      }
    }
    return { records: [], via: 'none', attempts }
  }

  /**
   * cb(err, target) with target = { address, port, via, srv, host }.
   * `host` is always what the caller typed; only `address`/`port` are for the
   * socket. Never throws.
   */
  function resolveTarget (host, port, cb) {
    const cleanHost = String(host || '').trim()
    const cleanPort = Number(port) || 25565
    const done = (err, target) => {
      try { cb(err, target) } catch (e) { /* caller's problem, not ours */ }
    }
    if (!cleanHost) return done(new Error('服务器地址为空'))
    if (isDirectHost(cleanHost)) {
      return done(null, { host: cleanHost, address: cleanHost, port: cleanPort, via: 'direct', srv: null })
    }

    const key = `${cleanHost}:${cleanPort}`
    const hit = cache.get(key)
    if (hit && hit.expires > now()) return done(null, hit.target)

    const work = (async () => {
      let target = { host: cleanHost, address: cleanHost, port: cleanPort, via: 'a', srv: null }
      let srv = null
      // Only vanilla's default port carries SRV; a literal port means the user
      // (or the server) already named the endpoint.
      if (cleanPort === 25565) srv = await srvLookup(cleanHost)
      const best = srv ? pickSrv(srv.records) : null
      if (best) {
        target = {
          host: cleanHost,
          address: best.name,
          port: best.port,
          via: srv.via,
          srv: `${best.name}:${best.port}`
        }
      }
      target.address = await lookupA(target.address)
      return { target, attempts: srv ? srv.attempts : null }
    })()

    work.then(
      ({ target }) => {
        cache.set(key, { target, expires: now() + cacheTtlMs })
        done(null, target)
      },
      (err) => {
        const e = new Error(err && err.code === 'ENOTFOUND'
          ? `域名不存在或无法解析：${cleanHost}`
          : `地址解析失败（${cleanHost}）：${err.message}`)
        e.code = err && err.code
        done(e)
      }
    )
  }

  function clearCache () { cache.clear() }

  return { resolveTarget, clearCache, srvLookup, lookupA }
}

const defaultResolver = createResolver()

module.exports = {
  createResolver,
  resolveTarget: defaultResolver.resolveTarget,
  clearResolveCache: defaultResolver.clearCache,
  parseDohSrv,
  pickSrv,
  isDirectHost,
  DOH_ENDPOINTS,
  SRV_PREFIX
}
