'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ChatStore, parseChatLine } = require('../src/bot/chat')

test('chat: keeps the last 200 messages', () => {
  const store = new ChatStore({ limit: 200 })
  for (let i = 0; i < 250; i++) store.push({ text: `m${i}` })
  assert.equal(store.history().length, 200)
  assert.equal(store.history()[0].text, 'm50')
  assert.equal(store.history().at(-1).text, 'm249')
})

test('chat: L0 trims to 50 and restores to 200', () => {
  const store = new ChatStore({ limit: 200 })
  for (let i = 0; i < 200; i++) store.push({ text: `m${i}` })
  store.setLimit(50)
  assert.equal(store.history().length, 50)
  assert.equal(store.history()[0].text, 'm150')
  store.setLimit(200)
  assert.equal(store.history().length, 50, 'history is not invented back')
})

test('chat: parses <name> says, /me and whispers', () => {
  assert.deepEqual(parseChatLine('<Steve> hello'), { kind: 'chat', from: 'Steve', text: 'hello' })
  assert.deepEqual(parseChatLine('* Alex waves'), { kind: 'action', from: 'Alex', text: 'waves' })
  assert.deepEqual(parseChatLine('[Bob -> me] psst'), { kind: 'whisper', from: 'Bob', text: 'psst' })
})

test('chat: server system messages stay system', () => {
  const parsed = parseChatLine('Steve joined the game', 'game_info')
  assert.equal(parsed.kind, 'system')
  assert.equal(parsed.from, '')
  assert.equal(parsed.text, 'Steve joined the game')
})

test('chat: messages carry protocol fields', () => {
  const store = new ChatStore()
  const msg = store.pushLine('<Steve> hi')
  assert.equal(msg.t, 'chat')
  assert.equal(msg.kind, 'chat')
  assert.equal(msg.from, 'Steve')
  assert.equal(msg.text, 'hi')
  assert.ok(Number.isFinite(msg.ts))
})
