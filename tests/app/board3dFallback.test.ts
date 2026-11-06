import { describe, expect, it } from 'vitest'
import { fallbackAlert } from '../../app/utils/board3dFallback'

describe('fallbackAlert', () => {
  it('says WebGL is off when the probe fails', () => {
    expect(fallbackAlert({ kind: 'no-webgl' })).toEqual({ title: '3D view needs WebGL, which this browser has turned off.' })
  })

  it('says the 3D view failed, with the reason, when it throws', () => {
    expect(fallbackAlert({ kind: 'error', error: new Error('Error creating WebGL context.') })).toEqual({
      title: 'The 3D view failed to start.',
      description: 'Error creating WebGL context.'
    })
    expect(fallbackAlert({ kind: 'error', error: 'chunk failed' }).description).toBe('chunk failed')
    expect(fallbackAlert({ kind: 'error' })).toEqual({ title: 'The 3D view failed to start.' })
  })
})
