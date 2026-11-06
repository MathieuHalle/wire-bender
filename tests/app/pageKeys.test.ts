import { describe, expect, it } from 'vitest'
import { LOCKED_TITLE, lockedAttrs, pageKey } from '../../app/utils/boardView'

describe('pageKey', () => {
  it('3 toggles the 3D view on and off, back to the last 2D view', () => {
    expect(pageKey('3', 'both', 'both')).toEqual({ view: '3d' })
    expect(pageKey('3', 'top', 'top')).toEqual({ view: '3d' })
    expect(pageKey('3', '3d', 'top')).toEqual({ view: 'top' })
    expect(pageKey('3', '3d', 'both')).toEqual({ view: 'both' })
  })

  it('Esc leaves 3D for both sides, and does nothing in 2D', () => {
    expect(pageKey('Escape', '3d', 'top')).toEqual({ view: 'both' })
    expect(pageKey('Escape', 'both', 'both')).toBeNull()
    expect(pageKey('Escape', 'bottom', 'bottom')).toBeNull()
  })

  it('F flips one large side, not in 3D', () => {
    expect(pageKey('f', 'both', 'both')).toEqual({ view: 'top' })
    expect(pageKey('F', 'top', 'top')).toEqual({ view: 'bottom' })
    expect(pageKey('f', '3d', 'both')).toBeNull()
  })

  it('zoom keys work in 2D and are off in 3D', () => {
    expect(pageKey('+', 'both', 'both')).toEqual({ zoom: 1 })
    expect(pageKey('=', 'top', 'top')).toEqual({ zoom: 1 })
    expect(pageKey('-', 'both', 'both')).toEqual({ zoom: -1 })
    expect(pageKey('0', 'both', 'both')).toEqual({ zoom: 0 })
    for (const k of ['+', '=', '-', '_', '0']) expect(pageKey(k, '3d', 'both'), k).toBeNull()
  })

  it('[ toggles the side panel, in 2D and in 3D', () => {
    expect(pageKey('[', 'both', 'both')).toEqual({ panel: 'toggle' })
    expect(pageKey('[', 'bottom', 'bottom')).toEqual({ panel: 'toggle' })
    expect(pageKey('[', '3d', 'both')).toEqual({ panel: 'toggle' })
  })
})

describe('lockedAttrs', () => {
  it('disables with the locked title in 3D, keeps the own title otherwise', () => {
    expect(LOCKED_TITLE).toBe('The 3D view is for looking: switch back to edit')
    expect(lockedAttrs(true, 'Zoom in (+)')).toEqual({ disabled: true, title: LOCKED_TITLE })
    expect(lockedAttrs(false, 'Zoom in (+)')).toEqual({ disabled: false, title: 'Zoom in (+)' })
    expect(lockedAttrs(false)).toEqual({ disabled: false, title: undefined })
  })
})
