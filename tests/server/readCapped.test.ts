import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readCapped } from '../../server/utils/readCapped'

describe('readCapped', () => {
  it('reads a body up to the limit', async () => {
    expect(await readCapped(Readable.from([Buffer.from('{"code":'), Buffer.from('"1"}')]), 4096)).toBe('{"code":"1"}')
    expect(await readCapped(Readable.from([Buffer.from('x'.repeat(10))]), 10)).toBe('x'.repeat(10))
  })

  it('stops past the limit, whatever content-length said, and does not read the rest', async () => {
    let pulled = 0
    async function* chunks() {
      for (let i = 0; i < 1000; i++) {
        pulled++
        yield Buffer.alloc(1024, 'a')
      }
    }
    expect(await readCapped(chunks(), 4096)).toBeNull()
    expect(pulled).toBeLessThanOrEqual(5)
  })
})
