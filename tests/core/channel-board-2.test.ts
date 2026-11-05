import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseBoard, type BoardFile } from '~core/schema'
import { placePart } from '~core/footprints'
import { holeName } from '~core/holes'
import { runCheck } from '~core/check'

const data = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../data/${name}`, import.meta.url)), 'utf8'))

function load(): BoardFile {
  const res = parseBoard(data('channel-board-2.wirebender.json'))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.board
}

describe('channel board 2 import', () => {
  it('parses, with 30 parts', () => {
    expect(load().parts).toHaveLength(30)
  })

  it('places every pin in the source hole (core placePart)', () => {
    const expected: Record<string, string> = data('channel-board-2.expected-pins.json')
    const actual: Record<string, string> = {}
    for (const part of load().parts)
      for (const pin of placePart(part).pins) actual[`${part.ref}.${pin.name}`] = holeName(pin.hole)
    expect(actual).toEqual(expected)
  })

  it('U1 pins 1 and 8 are no-connect', () => {
    const u1 = load().parts.find(p => p.ref === 'U1')!
    expect(u1.pins['1']).toBeNull()
    expect(u1.pins['8']).toBeNull()
  })

  it('has no openNet and no short', () => {
    const { findings } = runCheck(load())
    expect(findings.filter(f => f.rule === 'openNet' || f.rule === 'short')).toEqual([])
  })

  it('supply and mcu adjacency findings (snapshot)', () => {
    const { findings } = runCheck(load())
    const adj = findings
      .filter(f => f.rule === 'adjacent' && (f.level === 'mcu' || f.level === 'supply'))
      .map(f => `${f.level}: ${f.message}`)
    expect(adj).toMatchSnapshot()
  })
})
