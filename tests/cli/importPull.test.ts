import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importCmd, pullCmd } from '../../cli/commands'
import { openDb, type Db } from '../../server/db'
import * as api from '../../server/utils/api'
import { encodeBundle } from '../../core/bundle'
import { parseBoard } from '../../core/schema'

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

describe('pull key check', () => {
  it.each(['.', '..', 'a b', 'a/b'])('rejects %j without calling the server', async (key) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await pullCmd([key, '-o', path.join(dir, 'never.json')])).toBe(2)
    expect(err.join('\n')).toMatch(/board key/)
    expect(fetchMock).not.toHaveBeenCalled()
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

describe('bundles', () => {
  const goodZip = () => {
    const b = parseBoard(JSON.parse(readFileSync(fixturePath, 'utf8')))
    if (!b.ok) throw new Error('fixture')
    return encodeBundle({
      name: b.board.name,
      exportedAt: 1,
      board: b.board,
      revisions: [1, 2].map(n => ({ n, createdAt: n, author: 'A', how: 'edit' as const, target: null, summary: 's', board: b.board }))
    })
  }

  it('import of a bundle prints the revision count', async () => {
    const f = reply(201, { id: 'zz', name: 'My board', head: 2, revisions: 2 })
    vi.stubGlobal('fetch', f)
    const file = path.join(dir, 'a.wirebender.zip')
    writeFileSync(file, goodZip())
    expect(await importCmd([file, '--url', 'http://h:1', '--token', 'wb_x'])).toBe(0)
    expect(out.join('\n')).toBe('imported My board (2 revisions) → http://h:1/b/zz')
    const [url, init] = f.mock.calls[0] as unknown as [string, { method: string, headers: Record<string, string> }]
    expect(url).toBe('http://h:1/api/boards/import-bundle')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/zip')
    expect(init.headers.authorization).toBe('Bearer wb_x')
  })

  it('import of a bad bundle exits 2 without calling the server', async () => {
    const f = reply(201, { id: 'x' })
    vi.stubGlobal('fetch', f)
    const file = path.join(dir, 'bad.wirebender.zip')
    writeFileSync(file, 'not a zip')
    expect(await importCmd([file])).toBe(2)
    expect(f).not.toHaveBeenCalled()
    expect(out.join('\n')).toContain('Advisory only.')
  })

  it('pull --bundle writes the zip bytes', async () => {
    const zip = goodZip()
    const f = vi.fn(async () => new Response(zip, { status: 200 }))
    vi.stubGlobal('fetch', f)
    const file = path.join(dir, 'o.wirebender.zip')
    expect(await pullCmd(['abc', '-o', file, '--bundle', '--url', 'http://h'])).toBe(0)
    expect(new Uint8Array(readFileSync(file))).toEqual(zip)
    expect((f.mock.calls[0] as unknown[])[0]).toBe('http://h/api/boards/abc/bundle')
  })

  it('pull --bundle defaults the name and keeps the --force rule', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(goodZip(), { status: 200 })))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      expect(await pullCmd(['abc', '--bundle'])).toBe(0)
      expect(existsSync(path.join(dir, 'abc.wirebender.zip'))).toBe(true)
      expect(await pullCmd(['abc', '--bundle'])).toBe(2)
      expect(await pullCmd(['abc', '--bundle', '--force'])).toBe(0)
    } finally {
      process.chdir(cwd)
    }
  })

  it('pull --bundle passes a refusal through and writes nothing', async () => {
    vi.stubGlobal('fetch', reply(404, { error: 'Not found.' }))
    const file = path.join(dir, 'n.wirebender.zip')
    expect(await pullCmd(['abc', '-o', file, '--bundle'])).toBe(1)
    expect(err.join('\n')).toContain('Not found.')
    expect(existsSync(file)).toBe(false)
  })
})
