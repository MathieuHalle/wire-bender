import { describe, expect, it, vi } from 'vitest'
import { throttledNotify } from '../../app/utils/throttle'

describe('throttledNotify', () => {
  it('shows the same message at most once per 5 s', () => {
    let now = 0
    const show = vi.fn()
    const notify = throttledNotify(show, () => now)
    notify('offline')
    now = 1000
    notify('offline')
    now = 4999
    notify('offline')
    expect(show).toHaveBeenCalledTimes(1)
    now = 5000
    notify('offline')
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('a burst of different messages shows one per 1.5 s', () => {
    let now = 0
    const show = vi.fn()
    const notify = throttledNotify(show, () => now)
    notify('a')
    now = 100
    notify('b')
    now = 1400
    notify('c')
    expect(show.mock.calls.map(c => c[0])).toEqual(['a'])
    now = 1500
    notify('d')
    expect(show.mock.calls.map(c => c[0])).toEqual(['a', 'd'])
  })

  it('a message skipped by the burst limit can show later', () => {
    let now = 0
    const show = vi.fn()
    const notify = throttledNotify(show, () => now)
    notify('a')
    now = 100
    notify('b')
    now = 2000
    notify('b')
    expect(show.mock.calls.map(c => c[0])).toEqual(['a', 'b'])
  })
})
