import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importCmd, pullCmd } from '../../cli/commands'
import { openDb, type Db } from '../../server/db'
import * as api from '../../server/utils/api'

const fixturePath = path.resolve(__dirname, '../fixtures/channel-board-2.json')
let dir: string
let out: string[]
let err: string[]

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wirebender-cli-'))
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('import', () => {
  it('prints the board link and exits 0', async () => {
    const f = reply(200, { id: 'abc' })
    vi.stubGlobal('fetch', f)
    expect(await importCmd([fixturePath, '--url', 'http://h:1'])).toBe(0)
    expect(out.join('\n')).toMatch(/^imported .+ → http:\/\/h:1\/b\/abc$/)
    expect((f.mock.calls[0] as unknown[])[0]).toBe('http://h:1/api/boards')
  })

  it('of an invalid file exits 2 without calling the server', async () => {
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{"nope":1}')
    const f = reply(200, { id: 'x' })
    vi.stubGlobal('fetch', f)
    expect(await importCmd([bad])).toBe(2)
    expect(f).not.toHaveBeenCalled()
  })

  it('passes the server\'s 413 or 422 message through verbatim', async () => {
    vi.stubGlobal('fetch', reply(413, { error: 'Board is too large (max 1 MB).' }))
    expect(await importCmd([fixturePath])).toBe(1)
    expect(err.join('\n')).toContain('Board is too large (max 1 MB).')
    err.length = 0
    vi.stubGlobal('fetch', reply(422, { errors: ['name: bad', 'parts: worse'] }))
    expect(await importCmd([fixturePath])).toBe(1)
    expect(err.join('\n')).toContain('name: bad')
    expect(err.join('\n')).toContain('parts: worse')
  })

  it('a network failure says Cannot reach <url>', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    expect(await importCmd([fixturePath, '--url', 'http://nowhere:9'])).toBe(1)
    expect(err.join('\n')).toContain('Cannot reach http://nowhere:9')
  })
})

describe('pull', () => {
  const board = () => JSON.parse(readFileSync(fixturePath, 'utf8'))

  it('writes the board JSON, like the download route', async () => {
    vi.stubGlobal('fetch', reply(200, { id: 'abc', name: 'n', head: 3, board: board() }))
    const file = path.join(dir, 'o.json')
    expect(await pullCmd(['abc', '-o', file])).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(board(), null, 2)}\n`)
  })

  it('refuses to overwrite without --force', async () => {
    vi.stubGlobal('fetch', reply(200, { id: 'abc', name: 'n', head: 3, board: board() }))
    const file = path.join(dir, 'o.json')
    writeFileSync(file, 'keep')
    expect(await pullCmd(['abc', '-o', file])).toBe(2)
    expect(err.join('\n')).toContain(`${file} exists; add --force to overwrite`)
    expect(readFileSync(file, 'utf8')).toBe('keep')
    expect(await pullCmd(['abc', '-o', file, '--force'])).toBe(0)
    expect(readFileSync(file, 'utf8')).not.toBe('keep')
  })

  it('needs -o and writes nothing on a server refusal', async () => {
    vi.stubGlobal('fetch', reply(404, { error: 'Not found.' }))
    const file = path.join(dir, 'o.json')
    expect(await pullCmd(['abc', '-o', file])).toBe(1)
    expect(existsSync(file)).toBe(false)
    expect(await pullCmd(['abc'])).toBe(2)
  })
})

describe('against the real server functions', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(dir)
  })
  afterEach(() => db.$client.close())

  it('import then pull round-trips', async () => {
    const local = { kind: 'local', userId: 'local', author: 'Local' } as const
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string, body?: string }) => {
      const r = init.method === 'POST'
        ? api.createOrImport(db, init.body ?? '')
        : api.getBoardResponse(db, { key: new URL(url).pathname.split('/').pop()!, who: local })
      return new Response(JSON.stringify(r.body), { status: r.status })
    }))
    expect(await importCmd([fixturePath, '--url', 'http://h'])).toBe(0)
    const id = /\/b\/(\S+)$/.exec(out.join('\n'))![1]!
    const file = path.join(dir, 'pulled.json')
    expect(await pullCmd([id, '-o', file, '--url', 'http://h'])).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8')).name).toBe(board().name)
  })
})

function board() {
  return JSON.parse(readFileSync(fixturePath, 'utf8'))
}
