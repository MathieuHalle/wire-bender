import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FOOTPRINTS } from '~core/footprints'

// The format doc's footprint list (between its footprint-list markers) and the built-in
// footprints stay in step: every id is named or matches a pattern, and every name exists.
const doc = readFileSync(path.resolve(__dirname, '../../docs/format/wirebender-1.md'), 'utf8')
const list = doc.slice(doc.indexOf('<!-- footprint-list:start -->'), doc.indexOf('<!-- footprint-list:end -->'))
// Ids are lower case; a pattern's N (a count) or H (a height) is the only capital in it.
const names = [...list.matchAll(/`([a-zNH0-9.-]+)`/g)].map(m => m[1]!).filter(n => /^[a-z]/.test(n) && (n.includes('-') || /^(to92|axial|dip\w*)$/.test(n)))
const isPattern = (n: string) => /N|H/.test(n)
const patterns = names.filter(isPattern).map(n => new RegExp(`^${n.replace(/\./g, '\\.').replace(/N/g, '\\d+').replace(/H/g, '[\\d.]+')}$`))
const literal = names.filter(n => !isPattern(n))

describe('format doc footprint list', () => {
  it('names or patterns every built-in footprint', () => {
    const missing = Object.keys(FOOTPRINTS).filter(id => !literal.includes(id) && !patterns.some(re => re.test(id)))
    expect(missing).toEqual([])
  })

  it('names only footprints that exist', () => {
    const pinNames = new Set(['a', 'b'])
    expect(literal.filter(n => !pinNames.has(n) && !FOOTPRINTS[n])).toEqual([])
  })
})
