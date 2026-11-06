import { describe, expect, it } from 'vitest'
import { defaultPanel, loadPanel, PANEL_KEY, PANEL_TABS, parsePanel, savePanel, type PanelState } from '../../app/utils/sidePanel'

/** A Map-backed Storage, enough for get/set. */
function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v)
  }
}

const throwing = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  }
}

describe('side panel state', () => {
  it('defaults to open on Findings with every layer on', () => {
    expect(PANEL_KEY).toBe('wirebender:sidepanel')
    expect(defaultPanel()).toEqual({ open: true, tab: 'findings', layers: { components: true, wires: true, trails: true } })
    expect(PANEL_TABS.map(t => t.id)).toEqual(['findings', 'edit'])
  })

  it('round-trips through storage', () => {
    const s = memStorage()
    const state: PanelState = { open: false, tab: 'edit', layers: { components: false, wires: true, trails: false } }
    expect(savePanel(state, () => s)).toBe(true)
    expect(JSON.parse(s.map.get(PANEL_KEY)!)).toEqual(state)
    expect(loadPanel(() => s)).toEqual(state)
  })

  it('falls back to the defaults when nothing is stored', () => {
    expect(loadPanel(() => memStorage())).toEqual(defaultPanel())
  })

  it('falls back when the stored value is malformed', () => {
    for (const raw of ['not json', '"str"', '42', 'null', '[]', '{"open":"yes","tab":7,"layers":"x"}'])
      expect(parsePanel(raw), raw).toEqual(defaultPanel())
  })

  it('keeps the valid fields and replaces the bad ones', () => {
    expect(parsePanel('{"open":false,"tab":"nope","layers":{"components":false,"wires":"off"}}'))
      .toEqual({ open: false, tab: 'findings', layers: { components: false, wires: true, trails: true } })
  })

  it('survives a storage that throws, or none at all', () => {
    expect(loadPanel(() => throwing)).toEqual(defaultPanel())
    expect(savePanel(defaultPanel(), () => throwing)).toBe(false)
    const blocked = () => {
      throw new Error('localStorage is blocked')
    }
    expect(loadPanel(blocked)).toEqual(defaultPanel())
    expect(savePanel(defaultPanel(), blocked)).toBe(false)
    expect(loadPanel(() => null)).toEqual(defaultPanel())
    expect(savePanel(defaultPanel(), () => undefined)).toBe(false)
  })

  it('returns a fresh default each time', () => {
    const a = defaultPanel()
    a.layers.trails = false
    expect(defaultPanel().layers.trails).toBe(true)
  })
})
