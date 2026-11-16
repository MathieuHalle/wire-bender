import { describe, expect, it } from 'vitest'
import { blankBoard, BOARD_PRESETS, PRESET_IDS, presetBoard } from '~core/boardPresets'
import { parseBoard } from '~core/schema'

describe('board presets', () => {
  it('every preset is a valid board, named as asked', () => {
    for (const p of BOARD_PRESETS) {
      const b = presetBoard(p.id, 'My board')!
      expect(parseBoard(b).ok).toBe(true)
      expect(b.name).toBe('My board')
    }
  })

  it('the ids are unique and stable', () => {
    expect(PRESET_IDS).toEqual(['custom', 'proto-4x6', 'proto-5x7', 'proto-7x9', 'chogori-22004515'])
    expect(new Set(PRESET_IDS).size).toBe(PRESET_IDS.length)
  })

  it('sizes and sides as the design lists them', () => {
    expect(presetBoard('proto-4x6', 'x')!.board).toEqual({ cols: 14, rows: 20, pitchMm: 2.54, type: 'two-sided', blocked: [] })
    expect(presetBoard('proto-5x7', 'x')!.board).toMatchObject({ cols: 18, rows: 24, type: 'two-sided' })
    expect(presetBoard('proto-7x9', 'x')!.board).toMatchObject({ cols: 26, rows: 31, type: 'two-sided' })
  })

  it('the connector starts with J1: pin 1 + (red), pin 2 - (black)', () => {
    const b = presetBoard('chogori-22004515', 'Cable 1')!
    expect(b.board).toEqual({ cols: 2, rows: 2, pitchMm: 2.54, type: 'one-sided', blocked: [] })
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
