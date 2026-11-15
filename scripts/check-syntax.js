'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const roots = ['src', 'test', 'scripts']
const files = []

function walk (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js')) files.push(full)
  }
}

for (const root of roots) {
  const dir = path.join(__dirname, '..', root)
  if (fs.existsSync(dir)) walk(dir)
}

let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    failed += 1
    console.error(`syntax error in ${file}\n${err.stderr ? err.stderr.toString() : err.message}`)
  }
}
console.log(`checked ${files.length} files, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
