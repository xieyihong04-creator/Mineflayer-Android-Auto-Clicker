'use strict'

const { chatMessage } = require('../bridge/protocol')

/** Parses common chat lines into {from, text, kind}. */
function parseChatLine (text, position = 'chat') {
  const raw = String(text || '')
  let kind = position === 'game_info' ? 'system' : 'chat'
  let from = ''
  let body = raw
  let m = /^<([^>]{1,32})>\s?(.*)$/.exec(raw)
  if (m) {
    from = m[1]
    body = m[2]
  } else if ((m = /^\* ([^\s]+) (.*)$/.exec(raw))) {
    kind = 'action'
    from = m[1]
    body = m[2]
  } else if ((m = /^\[([^\]]{1,32})\s*->\s*me\]\s?(.*)$/.exec(raw))) {
    kind = 'whisper'
    from = m[1].trim()
    body = m[2]
  } else if (position === 'game_info') {
    kind = 'system'
  }
  return { kind, from, text: body }
}

/**
 * F3: keep the last 200 server messages. The limit shrinks to 50 in L0
 * (PRD §4) and is restored when the tier goes back up.
 */
class ChatStore {
  constructor ({ limit = 200, maxLimit = 200 } = {}) {
    this.maxLimit = maxLimit
    this.limit = limit
    this.messages = []
  }

  setLimit (limit) {
    this.limit = Math.max(1, Math.min(limit, this.maxLimit))
    this.trim()
  }

  trim () {
    if (this.messages.length > this.limit) {
      this.messages.splice(0, this.messages.length - this.limit)
    }
  }

  push (input) {
    const msg = chatMessage({
      ts: input.ts || Date.now(),
      kind: input.kind,
      from: input.from,
      text: input.text,
      raw: input.raw
    })
    this.messages.push(msg)
    this.trim()
    return msg
  }

  pushLine (text, position) {
    const parsed = parseChatLine(text, position)
    return this.push({ ...parsed, raw: text })
  }

  history () {
    return this.messages.slice()
  }
}

module.exports = { ChatStore, parseChatLine }
