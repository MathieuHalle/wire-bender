import { describe, it, expect } from 'vitest'
import { FOOTPRINTS, isDiodePart, placePart, rotateOffset } from '~core/footprints'
import { holeName, parseHole } from '~core/holes'
import { parseBoard } from '~core/schema'
import type { Part } from '~core/schema'

const part = (over: Partial<Part>): Part => ({
  ref: 'X1', footprint: 'dip8', at: 'A1', rotation: 0, pins: {}, ...over
})
const names = (p: Part) => Object.fromEntries(placePart(p).pins.map(x => [x.name, holeName(x.hole)]))

describe('placePart', () => {
  it('relay at D3 rotation 0', () => {
    const n = names(part({ footprint: 'relay-g5v2', at: 'D3' }))
    expect(n['16']).toBe('D6')
    expect(n['9']).toBe('K6')
  })

  it('dip8 matches channel board 2 U1', () => {
    const n = names(part({ footprint: 'dip8', at: 'W8', rotation: 270 }))
    expect(n).toEqual({ 1: 'W8', 2: 'W9', 3: 'W10', 4: 'W11', 5: 'T11', 6: 'T10', 7: 'T9', 8: 'T8' })
  })

  it('terminal body covers the row below', () => {
    const bh = placePart(part({ footprint: 'terminal-2p-508', at: 'A3' })).bodyHoles.map(holeName)
    for (const h of ['B3', 'B4', 'B5', 'A4']) expect(bh).toContain(h)
    for (const h of ['A3', 'A5']) expect(bh).not.toContain(h)
  })

  it('standing axial body only around lead a', () => {
    const p = placePart(part({ footprint: 'axial', at: 'L2', to: 'L1', standing: true }))
    expect(p.bodyHoles).toEqual([])
  })

  it('standing resistors are 2.5 mm wide, standing diodes 2.7 mm', () => {
    const r = placePart(part({ footprint: 'axial', at: 'L2', to: 'M2', standing: true, value: '10k' }))
    const d = placePart(part({ footprint: 'axial', at: 'L2', to: 'M2', standing: true, value: '1N4001' }))
    expect(r.bodyRectMm.w).toBeCloseTo(2.5, 9)
    expect(d.bodyRectMm.w).toBeCloseTo(2.7, 9)
    expect(isDiodePart(part({ footprint: 'axial', at: 'A1', label: 'D1N4148' }))).toBe(true)
  })

  it('two standing resistors fit side by side in one row', () => {
    const a = placePart(part({ footprint: 'axial', at: 'T17', to: 'U17', standing: true, value: '10k' })).bodyRectMm
    const b = placePart(part({ footprint: 'axial', at: 'T16', to: 'U16', standing: true, value: '10k' })).bodyRectMm
    expect(b.x + b.w).toBeLessThan(a.x)
  })

  it('a polyfuse fits within its 3 holes and stays clear of the next one', () => {
    const r = placePart(part({ footprint: 'polyfuse-radial', at: 'F9', to: 'F7' })).bodyRectMm
    expect(r.w).toBeCloseTo(7.0, 9)
    expect(r.w).toBeLessThan(3 * 2.54)
  })

  it('twoLead uses at/to and ignores rotation', () => {
    const n = names(part({ footprint: 'axial', at: 'C2', to: 'C6', rotation: 90 }))
    expect(n).toEqual({ a: 'C2', b: 'C6' })
  })

  it('pin role: override, then footprint, then passive', () => {
    const p = placePart(part({ footprint: 'dip8', roles: { 1: 'in' } }))
    expect(p.pins[0]!.role).toBe('in')
    expect(p.pins[1]!.role).toBe('passive')
  })

  it('flip mirrors dx before rotation', () => {
    const n = names(part({ footprint: 'dip8', at: 'D10', flip: true }))
    expect(n['5']).toBe('G7')
  })

  it('rotation 180 then 0 is identity for every footprint', () => {
    for (const fp of Object.values(FOOTPRINTS)) {
      if (fp.twoLead) continue
      const base = names(part({ footprint: fp.id, at: 'AZ60' }))
      const r180 = names(part({ footprint: fp.id, at: 'AZ60', rotation: 180 }))
      const p1 = parseHole('AZ60')
      for (const pin of fp.pins) {
        const h0 = parseHole(base[pin.name]!)
        const once = rotateOffset(h0.col - p1.col, h0.row - p1.row, 180)
        const back = rotateOffset(once.dx, once.dy, 180)
        expect([back.dx, back.dy]).toEqual([h0.col - p1.col, h0.row - p1.row])
        const h180 = parseHole(r180[pin.name]!)
        const rot = rotateOffset(h180.col - p1.col, h180.row - p1.row, 180)
        expect([rot.dx, rot.dy]).toEqual([h0.col - p1.col, h0.row - p1.row])
        let four = { dx: pin.dx, dy: pin.dy }
        for (let i = 0; i < 4; i++) four = rotateOffset(four.dx, four.dy, 90)
        expect([four.dx, four.dy]).toEqual([pin.dx, pin.dy])
      }
    }
  })
})

describe('body geometry', () => {
  const close = (r: { x: number, y: number, w: number, h: number }, e: number[]) => {
    expect(r.x).toBeCloseTo(e[0]!, 6)
    expect(r.y).toBeCloseTo(e[1]!, 6)
    expect(r.w).toBeCloseTo(e[2]!, 6)
    expect(r.h).toBeCloseTo(e[3]!, 6)
  }
  const bh = (p: Part) => placePart(p).bodyHoles.map(holeName).sort()

  it('relay at rotation 90 swaps the box to 20.5 x 10.1', () => {
    const r = placePart(part({ footprint: 'relay-g5v2', at: 'D10', rotation: 90 })).bodyRectMm
    close(r, [22.86 - 19.14, 7.62 - 1.24, 20.5, 10.1])
  })

  it('vertical axial body is 2.5 x 6.3 centred on the lead midpoint', () => {
    const r = placePart(part({ footprint: 'axial', at: 'C2', to: 'F2' })).bodyRectMm
    close(r, [2.54 - 1.25, 8.89 - 3.15, 2.5, 6.3])
  })

  it('horizontal axial body is 6.3 x 2.5', () => {
    const r = placePart(part({ footprint: 'axial', at: 'C2', to: 'C5' })).bodyRectMm
    close(r, [2.54 + 3.81 - 3.15, 5.08 - 1.25, 6.3, 2.5])
  })

  it('dip8 bodyHoles at rotation 0', () => {
    expect(bh(part({ footprint: 'dip8', at: 'D5' }))).toEqual(
      ['D6', 'D7', 'E6', 'E7', 'F6', 'F7', 'G6', 'G7'])
  })

  it('dip8 bodyHoles at rotation 270', () => {
    expect(bh(part({ footprint: 'dip8', at: 'W8', rotation: 270 }))).toEqual(
      ['U10', 'U11', 'U8', 'U9', 'V10', 'V11', 'V8', 'V9'])
  })

  it('TO-220 body sits over its pins, tab +x, and they rotate together', () => {
    // Straight legs: 4.5 thick across the pin line, the pins 2.5 from the tab (back) face.
    const r0 = placePart(part({ footprint: 'to220-gds', at: 'C3' }))
    const pin = { x: 2 * 2.54, y: 2 * 2.54 } // G at C3 (col 3, row 3)
    close(r0.bodyRectMm, [pin.x - 2.0, pin.y + 2.54 - 5, 4.5, 10])
    expect(r0.tab).toEqual({ dx: 1, dy: 0 })
    expect(FOOTPRINTS['to220-gds']!.tab).toEqual({ dx: 1, dy: 0 })
    // Rotation 90 (clockwise from the top): the pins run along -x, the tab points +y (down).
    const r90 = placePart(part({ footprint: 'to220-gds', at: 'C3', rotation: 90 }))
    expect(r90.tab).toEqual({ dx: 0, dy: 1 })
    close(r90.bodyRectMm, [pin.x - 2.54 - 5, pin.y - 2.0, 10, 4.5])
    // Flip mirrors the tab the way it mirrors dx.
    expect(placePart(part({ footprint: 'to220-gds', at: 'C3', flip: true })).tab).toEqual({ dx: -1, dy: 0 })
    const tabAt = (rotation: 0 | 90 | 180 | 270, flip = false) =>
      placePart(part({ footprint: 'to220-gds', at: 'C3', rotation, flip })).tab
    expect(tabAt(180)).toEqual({ dx: -1, dy: 0 })
    expect(tabAt(270)).toEqual({ dx: 0, dy: -1 })
    // Flip mirrors dx first, then the rotation: (-1, 0) -> (0, -1).
    expect(tabAt(90, true)).toEqual({ dx: 0, dy: -1 })
    expect(placePart(part({ footprint: 'dip8', at: 'C3' })).tab).toBeUndefined()
  })

  it('flipped dip8 body extends to the left of pin 1', () => {
    const r = placePart(part({ footprint: 'dip8', at: 'D10', flip: true })).bodyRectMm
    close(r, [22.86 - 6.985, 7.62 - 1.09, 6.35, 9.8])
  })
})

describe('schema footprint check', () => {
  it('rejects unknown footprint', () => {
    const r = parseBoard({
      format: 'wirebender/1', revision: 0, name: 't',
      board: { cols: 18, rows: 24, pitchMm: 2.54, type: 'one-sided', blocked: [] },
      netClasses: {}, nets: {}, rules: { keepAway: [], adjacency: [] },
      parts: [part({ footprint: 'nope' })], trails: [], wires: [], legFolds: [], solderBridges: []
    })
    expect(r).toEqual({ ok: false, errors: ['parts[0].footprint: unknown "nope"'] })
  })
})

describe('footprint families', () => {
  const p = (name: string, dx: number, dy: number) => ({ name, dx, dy })
  const pick = (id: string) => {
    const { shape: _s, dip: _d, header: _h, ...rest } = FOOTPRINTS[id]!
    return rest
  }

  it('keeps the ids from before the families exactly as they were', () => {
    expect(pick('dip8')).toEqual({
      id: 'dip8', name: 'DIP-8',
      pins: [p('1', 0, 0), p('2', 0, 1), p('3', 0, 2), p('4', 0, 3), p('5', 3, 3), p('6', 3, 2), p('7', 3, 1), p('8', 3, 0)],
      body: { rect: { x: 3 * 2.54 / 2 - 6.35 / 2, y: 3 * 2.54 / 2 - 9.8 / 2, w: 6.35, h: 9.8 }, heightMm: 4.5, side: 'top' }, mark: 'pin1'
    })
    expect(pick('terminal-2p-508')).toEqual({
      id: 'terminal-2p-508', name: 'Terminal block 2P 5.08',
      pins: [p('1', 0, 0), p('2', 2, 0)],
      body: { rect: { x: 2 * 2.54 / 2 - 5.08, y: 2.54 / 2 - 3.8, w: 10.16, h: 7.6 }, heightMm: 10, side: 'top' }
    })
    expect(pick('header-1x5')).toEqual({
      id: 'header-1x5', name: 'Header 1x5',
      pins: [p('1', 0, 0), p('2', 1, 0), p('3', 2, 0), p('4', 3, 0), p('5', 4, 0)],
      body: { rect: { x: -1.27, y: -1.25, w: 12.7, h: 2.5 }, heightMm: 8.5, side: 'top' }, mark: 'pin1'
    })
  })

  it('numbers a 2-row header with pin 2 under pin 1', () => {
    expect(FOOTPRINTS['header-2x3']!.pins).toEqual([p('1', 0, 0), p('2', 0, 1), p('3', 1, 0), p('4', 1, 1), p('5', 2, 0), p('6', 2, 1)])
    expect(FOOTPRINTS['socket-2x3']!.pins).toEqual(FOOTPRINTS['header-2x3']!.pins)
    expect(FOOTPRINTS['header-2x3']!.body.rect.h).toBeCloseTo(5.04)
  })

  it('numbers DIPs down one side and back up the other', () => {
    expect(FOOTPRINTS['dip16']!.pins.find(x => x.name === '9')).toEqual(p('9', 3, 7))
    expect(FOOTPRINTS['dip28-wide']!.pins.find(x => x.name === '15')).toEqual(p('15', 6, 13))
    expect(FOOTPRINTS['dip28-wide']!.body.rect.w).toBeCloseTo(13.97)
    expect(FOOTPRINTS['dip8-socket']!.body.heightMm).toBe(7.5)
    expect(FOOTPRINTS['dip8-socket']!.pins).toEqual(FOOTPRINTS['dip8']!.pins)
  })

  it('a DIP socket covers its pins; the chip alone does not', () => {
    const inside = (id: string) => {
      const pp = placePart(part({ footprint: id, at: 'D5', rotation: 90 }))
      const r = pp.bodyRectMm
      return pp.pins.every(({ hole }) => {
        const x = (hole.col - 1) * 2.54
        const y = (hole.row - 1) * 2.54
        return x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h
      })
    }
    expect(inside('dip14-socket')).toBe(true)
    expect(inside('dip14')).toBe(false)
  })

  it('spaces terminal poles 5.08 apart', () => {
    expect(FOOTPRINTS['terminal-4p-508']!.pins.map(x => x.dx)).toEqual([0, 2, 4, 6])
    expect(FOOTPRINTS['terminal-4p-508']!.body.rect.w).toBeCloseTo(20.32)
  })

  it('has no ids outside the families', () => {
    for (const id of ['header-1x41', 'header-1x0', 'socket-3x2', 'dip7', 'dip2', 'dip42', 'dip22-wide', 'dip22-wide-socket', 'terminal-7p-508', 'terminal-1p-508'])
      expect(FOOTPRINTS[id], id).toBeUndefined()
    for (const id of ['header-1x1', 'header-2x40', 'socket-1x40', 'dip4', 'dip40', 'dip40-wide-socket', 'terminal-6p-508'])
      expect(FOOTPRINTS[id], id).toBeDefined()
  })
})
