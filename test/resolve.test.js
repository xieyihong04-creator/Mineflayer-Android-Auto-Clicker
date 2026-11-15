'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createResolver, parseDohSrv, pickSrv, isDirectHost } = require('../src/util/resolve')

function fakeDns ({ srvError = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), srvRecords = null, addresses = {} } = {}) {
  const calls = { srv: 0, lookup: 0, looked: [] }
  return {
    calls,
    resolveSrv (name, cb) {
      calls.srv += 1
      if (srvRecords) cb(null, srvRecords)
      else cb(srvError)
    },
    lookup (host, options, cb) {
      calls.lookup += 1
      calls.looked.push([host, options.family])
      const hit = addresses[host]
      // Callback form: (err, address, family), like node's dns.lookup.
      if (hit === 'v6only') {
        if (options.family === 4) cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
        else cb(null, '2001:db8::1', 6)
      } else if (typeof hit === 'string') cb(null, hit, 4)
      else cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
    }
  }
}

const resolve = (resolver, host, port = 25565) => new Promise((resolve) => {
  resolver.resolveTarget(host, port, (err, target) => resolve({ err, target }))
})

test('direct hosts never touch DNS', async () => {
  const dnsModule = fakeDns()
  const resolver = createResolver({ dnsModule })
  for (const host of ['127.0.0.1', 'localhost', '2001:db8::1']) {
    const { err, target } = await resolve(resolver, host, 25565)
    assert.equal(err, null)
    assert.equal(target.address, host)
    assert.equal(target.via, 'direct')
  }
  assert.equal(dnsModule.calls.srv, 0)
  assert.equal(dnsModule.calls.lookup, 0)

  const plain = await resolve(resolver, '192.168.1.10', 25566)
  assert.equal(plain.target.port, 25566)
})

test('system SRV wins and the socket follows it, the typed host stays', async () => {
  const dnsModule = fakeDns({
    srvRecords: [
      { name: 'backup.example.net.', port: 25566, priority: 10, weight: 0 },
      { name: 'jp.example.net', port: 25565, priority: 0, weight: 5 }
    ],
    addresses: { 'jp.example.net': '172.65.211.204' }
  })
  const resolver = createResolver({ dnsModule })
  const { err, target } = await resolve(resolver, 'mc.example.net')
  assert.equal(err, null)
  assert.equal(target.host, 'mc.example.net')
  assert.equal(target.srv, 'jp.example.net:25565')
  assert.equal(target.address, '172.65.211.204')
  assert.equal(target.port, 25565)
  assert.equal(target.via, 'system')
})

test('c-ares failing is invisible: Cloudflare DoH supplies the SRV record', async () => {
  const dnsModule = fakeDns({ addresses: { 'jp.example.net': '172.65.211.204' } })
  const urls = []
  const resolver = createResolver({
    dnsModule,
    httpJson: async (url) => {
      urls.push(url)
      return {
        Status: 0,
        Answer: [{ name: '_minecraft._tcp.mc.example.net.', type: 33, data: '0 5 25565 jp.example.net.' }]
      }
    }
  })
  const { err, target } = await resolve(resolver, 'mc.example.net')
  assert.equal(err, null)
  assert.equal(target.via, 'cloudflare')
  assert.equal(target.srv, 'jp.example.net:25565')
  assert.match(urls[0], /cloudflare-dns\.com/)
  assert.match(urls[0], /_minecraft\._tcp\.mc\.example\.net/)
})

test('google DoH is the second fallback', async () => {
  const dnsModule = fakeDns({ addresses: { 'jp.example.net': '172.65.211.204' } })
  const urls = []
  const resolver = createResolver({
    dnsModule,
    httpJson: async (url) => {
      urls.push(url)
      if (url.includes('cloudflare')) throw new Error('http 503')
      return { Answer: [{ type: 33, data: '0 0 25565 jp.example.net.' }] }
    }
  })
  const { err, target } = await resolve(resolver, 'mc.example.net')
  assert.equal(err, null)
  assert.equal(target.via, 'google')
  assert.equal(urls.length, 2)
})

test('no SRV anywhere -> plain A record of the typed host', async () => {
  const dnsModule = fakeDns({ addresses: { 'mc.example.net': '203.0.113.9' } })
  const resolver = createResolver({
    dnsModule,
    httpJson: async () => ({ Status: 0, Answer: [] })
  })
  const { err, target } = await resolve(resolver, 'mc.example.net')
  assert.equal(err, null)
  assert.equal(target.srv, null)
  assert.equal(target.via, 'a')
  assert.equal(target.address, '203.0.113.9')
  assert.equal(target.host, 'mc.example.net')
})

test('a non-default port skips SRV, like the vanilla client', async () => {
  const dnsModule = fakeDns({ addresses: { 'mc.example.net': '203.0.113.9' } })
  const resolver = createResolver({ dnsModule })
  const { err, target } = await resolve(resolver, 'mc.example.net', 25566)
  assert.equal(err, null)
  assert.equal(dnsModule.calls.srv, 0)
  assert.equal(target.port, 25566)
  assert.equal(target.address, '203.0.113.9')
})

test('IPv6-only hosts are still usable', async () => {
  const dnsModule = fakeDns({ addresses: { 'mc.example.net': 'v6only' } })
  const resolver = createResolver({ dnsModule, httpJson: async () => ({ Answer: [] }) })
  const { err, target } = await resolve(resolver, 'mc.example.net')
  assert.equal(err, null)
  assert.equal(target.address, '2001:db8::1')
})

test('unresolvable host reports a Chinese, actionable error', async () => {
  const dnsModule = fakeDns()
  const resolver = createResolver({ dnsModule, httpJson: async () => ({ Answer: [] }) })
  const { err, target } = await resolve(resolver, 'mcfalout.net')
  assert.ok(err)
  assert.equal(target, undefined)
  assert.match(err.message, /域名不存在或无法解析/)
})

test('results are cached for the TTL, then refreshed', async () => {
  const dnsModule = fakeDns({ addresses: { 'mc.example.net': '203.0.113.9' } })
  let clock = 1000
  const resolver = createResolver({ dnsModule, now: () => clock, cacheTtlMs: 1000, httpJson: async () => ({ Answer: [] }) })
  await resolve(resolver, 'mc.example.net')
  const afterFirst = dnsModule.calls.lookup
  await resolve(resolver, 'mc.example.net')
  assert.equal(dnsModule.calls.lookup, afterFirst)
  clock += 1500
  await resolve(resolver, 'mc.example.net')
  assert.equal(dnsModule.calls.lookup, afterFirst + 1)
})

test('DoH SRV parsing and RFC 2782 ordering', () => {
  assert.deepEqual(parseDohSrv({ Answer: [{ type: 33, data: '10 20 25566 a.example.net.' }] }), [
    { name: 'a.example.net', port: 25566, priority: 10, weight: 20 }
  ])
  assert.deepEqual(parseDohSrv({ Answer: [{ type: 1, data: '203.0.113.9' }] }), [])
  assert.equal(
    pickSrv([
      { name: 'b', port: 1, priority: 5, weight: 1 },
      { name: 'a', port: 2, priority: 0, weight: 1 },
      { name: 'c', port: 3, priority: 0, weight: 9 }
    ]).name,
    'c'
  )
})

test('isDirectHost covers the fast paths', () => {
  assert.equal(isDirectHost('127.0.0.1'), true)
  assert.equal(isDirectHost('::1'), true)
  assert.equal(isDirectHost('localhost'), true)
  assert.equal(isDirectHost('mc.example.net'), false)
})
