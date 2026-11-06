import { describe, it, expect } from 'vitest'
import { tagNets, type Tag } from '~core/scene3d'

describe('tagNets', () => {
  const t = (over: Partial<Tag>): Tag => ({ kind: 'trail', id: 'T1', ...over })

  it('is the group nets when known, else the own net', () => {
    expect(tagNets(t({ net: 'GND', nets: ['GND', 'V12'] }))).toEqual(['GND', 'V12'])
    expect(tagNets(t({ net: 'GND' }))).toEqual(['GND'])
    expect(tagNets(t({ net: null, nets: [] }))).toEqual([])
  })

  it('is empty for no tag, NC and an empty-string net', () => {
    expect(tagNets(null)).toEqual([])
    expect(tagNets(undefined)).toEqual([])
    expect(tagNets(t({ net: null }))).toEqual([])
    expect(tagNets(t({ net: '' }))).toEqual([])
    expect(tagNets(t({ nets: [''] }))).toEqual([])
    expect(tagNets({ kind: 'part', id: 'U1' })).toEqual([])
  })
})
