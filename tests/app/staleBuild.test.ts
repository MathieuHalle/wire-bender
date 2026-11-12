import { describe, expect, it } from 'vitest'
import { isStaleBuild } from '../../app/utils/staleBuild'
import { fallbackAlert } from '../../app/utils/board3dFallback'

describe('isStaleBuild', () => {
  it('spots each browser\'s wording of a missing code file', () => {
    expect(isStaleBuild(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isStaleBuild(new TypeError('Failed to fetch dynamically imported module: http://x/_nuxt/Board3D.abc.js'))).toBe(true)
    expect(isStaleBuild(new TypeError('error loading dynamically imported module: http://x/_nuxt/a.js'))).toBe(true)
    expect(isStaleBuild(new Error('Unable to preload CSS for /_nuxt/a.css'))).toBe(true)
  })

  it('leaves other failures alone', () => {
    expect(isStaleBuild(new Error('Error creating WebGL context.'))).toBe(false)
    expect(isStaleBuild(undefined)).toBe(false)
  })
})

describe('fallbackAlert after an update', () => {
  it('says to reload instead of showing the browser\'s message', () => {
    expect(fallbackAlert({ kind: 'error', error: new TypeError('Importing a module script failed.') })).toEqual({
      title: 'WireBender was updated.',
      description: 'Reload the page to use the new version.',
      reload: true
    })
  })
})
