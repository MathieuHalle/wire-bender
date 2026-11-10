import { describe, expect, it } from 'vitest'
import { seal, sealKey, unseal } from '../../server/utils/sealed'

const key = sealKey('a'.repeat(64))

describe('sealed link passwords', () => {
  it('round-trips, emoji included, and never stores the plain text', () => {
    for (const plain of ['open sesame', 'pässwörd 🔌', 'x'.repeat(100)]) {
      const s = seal(key, plain)
      expect(s).not.toContain(plain)
      expect(unseal(key, s)).toBe(plain)
    }
  })

  it('seals the same password differently each time', () => {
    expect(seal(key, 'same')).not.toBe(seal(key, 'same'))
  })

  it('another secret, a changed byte or a non-sealed value reads as null', () => {
    const s = seal(key, 'secret')
    expect(unseal(sealKey('b'.repeat(64)), s)).toBeNull()
    const parts = s.split('.')
    parts[3] = Buffer.from('tampered').toString('base64url')
    expect(unseal(key, parts.join('.'))).toBeNull()
    for (const bad of ['', 'garbled', 'v2.a.b.c', `${s}.extra`]) expect(unseal(key, bad)).toBeNull()
  })
})
