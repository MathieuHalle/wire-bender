import { describe, expect, it } from 'vitest'
import { RETURN_TTL_MS, returnEntry, returnPath } from '../../app/utils/boardView'

describe('returnPath', () => {
  it('gives back a board path stored less than 10 minutes ago', () => {
    const stored = returnEntry('/b/abc-123', 1000)
    expect(returnPath(stored, 1000 + RETURN_TTL_MS - 1)).toBe('/b/abc-123')
    expect(RETURN_TTL_MS).toBe(10 * 60_000)
  })

  it('ignores an old, future, malformed or foreign entry', () => {
    expect(returnPath(returnEntry('/b/abc', 1000), 1000 + RETURN_TTL_MS + 1)).toBeNull()
    expect(returnPath(returnEntry('/b/abc', 5000), 1000)).toBeNull()
    expect(returnPath(null, 1000)).toBeNull()
    expect(returnPath('/b/abc', 1000)).toBeNull()
    expect(returnPath('{"path":"/b/abc"}', 1000)).toBeNull()
    for (const path of ['//evil.example', '/b/../x', 'https://evil.example/b/x', '/account']) {
      expect(returnPath(returnEntry(path, 1000), 1000), path).toBeNull()
    }
  })

  it('gives back the dashboard pages, nothing else', () => {
    for (const p of ['/boards', '/boards/shared', '/boards/trash', '/settings', '/settings/account', '/settings/devices', '/settings/connections', '/settings/admin'])
      expect(returnPath(returnEntry(p, 1000), 1000), p).toBe(p)
    for (const p of ['/settings/evil', '/boards/x', '/boards?list=trash', '/settings/account?error=x', '/login', '/', '/boards/'])
      expect(returnPath(returnEntry(p, 1000), 1000), p).toBeNull()
  })
})
