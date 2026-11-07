import { describe, expect, it } from 'vitest'
import { wsBoardId } from '../../server/utils/wsBoardId'

describe('wsBoardId', () => {
  it('reads the id from the path, ignoring the query', () => {
    expect(wsBoardId('/_ws/board/d44a6caf-4ecf-4a25-878e-34d2ee59cc45')).toBe('d44a6caf-4ecf-4a25-878e-34d2ee59cc45')
    expect(wsBoardId('ws://localhost:3002/_ws/board/abc?x=1')).toBe('abc')
    expect(wsBoardId('/_ws/board/a%20b')).toBe('a b')
  })

  it('is null for a malformed escape', () => {
    expect(wsBoardId('/_ws/board/%E0%A4')).toBeNull()
  })

  it('is null for an empty or missing id', () => {
    expect(wsBoardId('/_ws/board/')).toBeNull()
    expect(wsBoardId('/_ws/board')).toBeNull()
    expect(wsBoardId('/_ws/board/a/b')).toBeNull()
  })
})
