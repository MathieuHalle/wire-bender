import { describe, expect, it } from 'vitest'
import { benchUrl, FLIP_KEY, loadFlip, saveFlip } from '../../app/utils/bottomFlip'

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

describe('bottom flip choice', () => {
  it('defaults to left-right when nothing (or nothing valid) is stored', () => {
    expect(FLIP_KEY).toBe('wirebender:bottomflip')
    expect(loadFlip(() => memStorage())).toBe('lr')
    expect(loadFlip(() => memStorage({ [FLIP_KEY]: 'sideways' }))).toBe('lr')
    expect(loadFlip(() => memStorage({ [FLIP_KEY]: '"tb"' }))).toBe('lr')
  })

  it('round-trips through storage', () => {
    const s = memStorage()
    expect(saveFlip('tb', () => s)).toBe(true)
    expect(s.map.get(FLIP_KEY)).toBe('tb')
    expect(loadFlip(() => s)).toBe('tb')
    expect(saveFlip('lr', () => s)).toBe(true)
    expect(loadFlip(() => s)).toBe('lr')
  })

  it('works without storage: missing, throwing, or the getter itself throwing', () => {
    expect(loadFlip(() => null)).toBe('lr')
    expect(loadFlip(() => throwing)).toBe('lr')
    expect(loadFlip(() => {
      throw new Error('SecurityError')
    })).toBe('lr')
    expect(saveFlip('tb', () => null)).toBe(false)
    expect(saveFlip('tb', () => throwing)).toBe(false)
    expect(saveFlip('tb', () => {
      throw new Error('SecurityError')
    })).toBe(false)
  })
})

describe('benchUrl', () => {
  it('always passes the flip, the id encoded', () => {
    expect(benchUrl('abc', 'lr')).toBe('/api/boards/abc/bench?flip=lr')
    expect(benchUrl('abc', 'tb')).toBe('/api/boards/abc/bench?flip=tb')
    expect(benchUrl('a/b c', 'tb')).toBe('/api/boards/a%2Fb%20c/bench?flip=tb')
  })
})
