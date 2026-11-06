import { describe, expect, it } from 'vitest'
import { ZOOM_STEPS, zoomStep } from '../../app/utils/boardView'

describe('zoomStep', () => {
  it('walks the steps up and down', () => {
    expect(zoomStep(1, 1)).toBe(1.5)
    expect(zoomStep(1.5, 1)).toBe(2)
    expect(zoomStep(2, -1)).toBe(1.5)
  })
  it('clamps at both ends', () => {
    expect(zoomStep(ZOOM_STEPS[0], -1)).toBe(1)
    expect(zoomStep(6, 1)).toBe(6)
  })
  it('snaps an off-step value to the next step', () => {
    expect(zoomStep(1.7, 1)).toBe(2)
    expect(zoomStep(1.7, -1)).toBe(1.5)
  })
})
