import { describe, it, expect } from 'vitest'
import { safeColor } from '~core/color'
import { safeColor as fromExport } from '../../export/svg'

describe('safeColor', () => {
  it('keeps hex and named colours', () => {
    expect(safeColor('#1f6fb2', 'x')).toBe('#1f6fb2')
    expect(safeColor('#abc', 'x')).toBe('#abc')
    expect(safeColor('orange', 'x')).toBe('orange')
  })

  it('falls back for anything else', () => {
    for (const c of [null, undefined, '', 'red;stroke:blue', 'url(#a)', '#12345g', 'rgb(1,2,3)', '"><script>'])
      expect(safeColor(c, '#000'), String(c)).toBe('#000')
  })

  it('is the one the bench sheet uses', () => {
    expect(fromExport).toBe(safeColor)
  })
})
