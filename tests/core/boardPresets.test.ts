import { describe, expect, it } from 'vitest'
import { blankBoard, BOARD_PRESETS, PRESET_IDS, presetBoard } from '~core/boardPresets'
import { parseBoard } from '~core/schema'
import { existingHoles } from '~core/boardShape'
import { breadboard400 } from './helpers'

describe('board presets', () => {
  it('every preset is a valid board, named as asked', () => {
    for (const p of BOARD_PRESETS) {
      const b = presetBoard(p.id, 'My board')!
      expect(parseBoard(b).ok).toBe(true)
      expect(b.name).toBe('My board')
    }
  })

  it('the ids are unique and stable', () => {
    expect(PRESET_IDS).toEqual(['custom', 'proto-4x6', 'proto-5x7', 'proto-7x9', 'chogori-22004515', 'bb-830', 'bb-830-full', 'bb-400', 'bb-170', 'vero-95x127', 'vero-64x95'])
    expect(new Set(PRESET_IDS).size).toBe(PRESET_IDS.length)
  })

  it('sizes and sides as the design lists them', () => {
    expect(presetBoard('proto-4x6', 'x')!.board).toEqual({ cols: 14, rows: 20, pitchMm: 2.54, type: 'two-sided', blocked: [] })
    expect(presetBoard('proto-5x7', 'x')!.board).toMatchObject({ cols: 18, rows: 24, type: 'two-sided' })
    expect(presetBoard('proto-7x9', 'x')!.board).toMatchObject({ cols: 26, rows: 31, type: 'two-sided' })
  })

  it('the connector starts with J1: pin 1 + (red), pin 2 - (black)', () => {
    const b = presetBoard('chogori-22004515', 'Cable 1')!
    expect(b.board).toEqual({ cols: 2, rows: 2, pitchMm: 2.54, type: 'one-sided', blocked: [], shape: { kind: 'round' } })
    // Round, and its four holes all there.
    expect(existingHoles(b.board)).toHaveLength(4)
    expect(b.parts).toEqual([{ ref: 'J1', footprint: 'header-2x2', at: 'A1', rotation: 0, value: 'CHOGORI 22004515-01', pins: { 1: '+', 2: '-', 3: null, 4: null } }])
    expect(b.nets).toEqual({ '+': { color: '#d62839' }, '-': { color: '#222222' } })
  })

  it('a board from a preset is a copy: changing it leaves the list alone', () => {
    const b = presetBoard('chogori-22004515', 'x')!
    b.parts[0]!.pins['1'] = 'VCC'
    b.nets['+']!.color = '#000'
    expect(presetBoard('chogori-22004515', 'x')!.parts[0]!.pins['1']).toBe('+')
    expect(presetBoard('chogori-22004515', 'x')!.nets['+']!.color).toBe('#d62839')
  })

  it('custom and unknown ids give no board', () => {
    expect(presetBoard('custom', 'x')).toBeNull()
    expect(presetBoard('nope', 'x')).toBeNull()
  })

  it('blankBoard is the empty board of that size', () => {
    const b = blankBoard('Blank', { cols: 10, rows: 8, pitchMm: 2.54, type: 'two-sided' })
    expect(parseBoard(b).ok).toBe(true)
    expect(b).toMatchObject({ name: 'Blank', parts: [], wires: [], trails: [], board: { cols: 10, rows: 8, blocked: [] } })
  })
})

describe('breadboard presets', () => {
  const bb = (id: string) => presetBoard(id, 'x')!
  it.each([['bb-830', 830], ['bb-830-full', 830], ['bb-400', 400], ['bb-170', 170]])('%s has %i holes (tie points, rails included)', (id, n) => {
    const b = bb(id)
    expect(parseBoard(b).ok).toBe(true)
    expect(b.board.type).toBe('breadboard')
    expect(existingHoles(b.board)).toHaveLength(n)
  })
  it('has clip strips of 5 holes, one per column on each half', () => {
    const b = bb('bb-400')
    const clips = b.board.strips!.filter(s => !s.skip)
    expect(clips).toHaveLength(60)
    expect(clips[0]).toEqual({ from: 'D1', to: 'H1' })
    expect(clips[1]).toEqual({ from: 'K1', to: 'O1' })
  })
  it('lays the rails as the design says: 400 one strip per rail, 830 split in the middle', () => {
    const rails = (id: string) => bb(id).board.strips!.filter(s => s.from.startsWith('A'))
    expect(rails('bb-400')).toEqual([{ from: 'A2', to: 'A30', skip: ['A7', 'A13', 'A19', 'A25'] }])
    expect(rails('bb-830-full')).toEqual([{ from: 'A3', to: 'A61', skip: ['A8', 'A14', 'A20', 'A26', 'A32', 'A38', 'A44', 'A50', 'A56'] }])
    expect(rails('bb-830')).toEqual([
      { from: 'A3', to: 'A31', skip: ['A8', 'A14', 'A20', 'A26'] },
      { from: 'A33', to: 'A61', skip: ['A38', 'A44', 'A50', 'A56'] }
    ])
    expect(bb('bb-830').board.strips!).toHaveLength(63 * 2 + 8)
  })
  it('prints the row names', () => {
    expect(bb('bb-400').board.rowLabels).toEqual(['+', '-', '', 'j', 'i', 'h', 'g', 'f', '', '', 'e', 'd', 'c', 'b', 'a', '', '-', '+'])
    expect(bb('bb-170').board.rowLabels).toEqual(['j', 'i', 'h', 'g', 'f', '', '', 'e', 'd', 'c', 'b', 'a'])
    expect(bb('bb-170').board.rows).toBe(12)
  })
  it('matches the 400 the core tests use', () => {
    const { cols, rows, type, shape, strips, rowLabels } = bb('bb-400').board
    expect({ cols, rows, type, shape, strips, rowLabels }).toEqual(breadboard400())
  })
})

describe('stripboard presets', () => {
  it.each([['vero-95x127', 50, 36], ['vero-64x95', 37, 24]])('%s: one-sided, %i holes by %i strips, one strip per row', (id, cols, rows) => {
    const b = presetBoard(id, 'x')!
    expect(parseBoard(b).ok).toBe(true)
    expect(b.board).toMatchObject({ cols, rows, type: 'one-sided' })
    expect(b.board.strips).toHaveLength(rows)
    expect(b.board.strips![0]).toEqual({ from: 'A1', to: `A${cols}` })
  })
})
