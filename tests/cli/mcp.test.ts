import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpServer, type Call } from '../../cli/mcp'

const ADVISORY = 'Advisory only. Check the board with a meter before powering it.'
const repo = path.resolve(__dirname, '../..')

type Reply = { status: number, json: unknown }
type Route = (method: string, path: string, body?: unknown) => Reply

let client: Client | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
})

/** A client connected in memory to a server whose API calls go to `route`. */
async function connect(route: Route): Promise<{ client: Client, call: ReturnType<typeof vi.fn<Call>> }> {
  const call = vi.fn<Call>(async (method, p, body) => route(method, p, body))
  const server = createMcpServer(call)
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return { client, call }
}

const textOf = (r: unknown): string => ((r as { content: { type: string, text: string }[] }).content).map(c => c.text).join('\n')
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true

describe('mcp server', () => {
  it('tools are listed with these names', async () => {
    const { client } = await connect(() => ({ status: 200, json: {} }))
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      'check_board', 'create_board', 'get_board', 'get_revision', 'list_boards', 'list_revisions',
      'redo', 'replace_board', 'restore_revision', 'undo'
    ])
    const replace = tools.find(t => t.name === 'replace_board')!
    expect(replace.inputSchema.required).toEqual(expect.arrayContaining(['board', 'baseRevision', 'data']))
    expect(replace.description).toMatch(/baseRevision/)
    expect(replace.description).toMatch(/409/)
  })

  it.each(['.', '..', 'a b', 'a/b'])('a bad board key %j fails locally and never calls the server', async (key) => {
    const { client, call } = await connect(() => ({ status: 200, json: {} }))
    const r = await client.callTool({ name: 'get_board', arguments: { board: key } })
    expect(isError(r)).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })

  it('list_revisions says newest first', async () => {
    const { client } = await connect(() => ({ status: 200, json: {} }))
    const t = (await client.listTools()).tools.find(x => x.name === 'list_revisions')!
    expect(t.description).toMatch(/newest first/)
  })

  it('replace_board requires baseRevision', async () => {
    const { client, call } = await connect(() => ({ status: 200, json: { revision: 2 } }))
    const r = await client.callTool({ name: 'replace_board', arguments: { board: 'b1', data: { name: 'x' } } })
    expect(isError(r)).toBe(true)
    expect(textOf(r)).toMatch(/baseRevision/)
    expect(call).not.toHaveBeenCalled()
  })

  it('replace_board sends baseRevision with the board', async () => {
    const { client, call } = await connect(() => ({ status: 200, json: { revision: 6 } }))
    const r = await client.callTool({ name: 'replace_board', arguments: { board: 'b-1', baseRevision: 5, data: { name: 'x' } } })
    expect(isError(r)).toBe(false)
    expect(JSON.parse(textOf(r))).toEqual({ revision: 6 })
    expect(call).toHaveBeenCalledWith('PUT', '/api/boards/b-1', { baseRevision: 5, board: { name: 'x' } })
  })

  it('a 409 gives the "read it again" message and changes nothing', async () => {
    const { client, call } = await connect(() => ({ status: 409, json: { current: 7 } }))
    const r = await client.callTool({ name: 'replace_board', arguments: { board: 'b1', baseRevision: 5, data: { name: 'x' } } })
    expect(isError(r)).toBe(true)
    expect(textOf(r)).toBe('The board changed since revision 5; read it again (head is 7) and redo your change.')
    // One PUT, never retried.
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('a 409 without a head reads it from a fresh GET, and writes nothing more', async () => {
    const { client, call } = await connect(m => m === 'GET' ? { status: 200, json: { id: 'b1', head: 9, board: {} } } : { status: 409, json: {} })
    const r = await client.callTool({ name: 'replace_board', arguments: { board: 'b1', baseRevision: 5, data: { name: 'x' } } })
    expect(textOf(r)).toBe('The board changed since revision 5; read it again (head is 9) and redo your change.')
    expect(call.mock.calls.map(c => c[0])).toEqual(['PUT', 'GET'])
  })

  it('get_board returns id, name, head, role and board', async () => {
    const { client, call } = await connect(() => ({ status: 200, json: { id: 'b1', name: 'N', head: 3, role: 'owner', board: { name: 'N' }, owner: { name: 'L' }, forkedFrom: null } }))
    const r = await client.callTool({ name: 'get_board', arguments: { board: 'b1' } })
    expect(JSON.parse(textOf(r))).toEqual({ id: 'b1', name: 'N', head: 3, role: 'owner', board: { name: 'N' } })
    expect(call).toHaveBeenCalledWith('GET', '/api/boards/b1', undefined)
  })

  it('check_board ends with the advisory line', async () => {
    const { client } = await connect(() => ({ status: 200, json: { findings: [], stats: { errors: 0 }, advisory: ADVISORY } }))
    const r = await client.callTool({ name: 'check_board', arguments: { board: 'b1' } })
    expect(isError(r)).toBe(false)
    expect(textOf(r).trimEnd().split('\n').at(-1)).toBe(ADVISORY)
  })

  it('server error messages pass through verbatim', async () => {
    const replies: Record<string, Reply> = {
      'GET /api/boards/gone': { status: 404, json: { error: 'Board not found.' } },
      'POST /api/boards/b1/undo': { status: 409, json: { reason: 'nothing to undo' } },
      'POST /api/boards/b1/redo': { status: 409, json: { reason: 'nothing to redo' } },
      'POST /api/boards': { status: 422, json: { errors: ['name: bad', 'parts: worse'] } },
      'GET /api/boards?list=mine': { status: 401, json: { error: 'Invalid token.' } },
      'POST /api/boards/b1/revisions/3/restore': { status: 403, json: { error: 'Not allowed with a token.' } }
    }
    const { client } = await connect((m, p) => replies[`${m} ${p}`] ?? { status: 500, json: { error: `unexpected ${m} ${p}` } })
    const cases: [string, Record<string, unknown>, string][] = [
      ['get_board', { board: 'gone' }, 'Board not found.'],
      ['undo', { board: 'b1' }, 'nothing to undo'],
      ['redo', { board: 'b1' }, 'nothing to redo'],
      ['create_board', { data: { name: 'x' } }, 'name: bad\nparts: worse'],
      ['list_boards', {}, 'Invalid token.'],
      ['restore_revision', { board: 'b1', n: 3 }, 'Not allowed with a token.']
    ]
    for (const [name, args, text] of cases) {
      const r = await client.callTool({ name, arguments: args })
      expect(isError(r), name).toBe(true)
      expect(textOf(r), name).toBe(text)
    }
  })

  it('a network failure says Cannot reach', async () => {
    const { client } = await connect(() => ({ status: 0, json: { error: 'Cannot reach http://nowhere:9: fetch failed' } }))
    const r = await client.callTool({ name: 'list_revisions', arguments: { board: 'b1' } })
    expect(isError(r)).toBe(true)
    expect(textOf(r)).toBe('Cannot reach http://nowhere:9: fetch failed')
  })

  it('every tool calls its route', async () => {
    const { client, call } = await connect(() => ({ status: 200, json: { ok: true } }))
    await client.callTool({ name: 'list_boards', arguments: { list: 'trash' } })
    await client.callTool({ name: 'list_revisions', arguments: { board: 'b1' } })
    await client.callTool({ name: 'get_revision', arguments: { board: 'b1', n: 2 } })
    await client.callTool({ name: 'undo', arguments: { board: 'b1' } })
    await client.callTool({ name: 'redo', arguments: { board: 'b1' } })
    await client.callTool({ name: 'restore_revision', arguments: { board: 'b1', n: 2 } })
    await client.callTool({ name: 'create_board', arguments: { data: { name: 'x' } } })
    await client.callTool({ name: 'check_board', arguments: { board: 'b1' } })
    expect(call.mock.calls).toEqual([
      ['GET', '/api/boards?list=trash', undefined],
      ['GET', '/api/boards/b1/revisions', undefined],
      ['GET', '/api/boards/b1/revisions/2', undefined],
      ['POST', '/api/boards/b1/undo', undefined],
      ['POST', '/api/boards/b1/redo', undefined],
      ['POST', '/api/boards/b1/revisions/2/restore', undefined],
      ['POST', '/api/boards', { board: { name: 'x' } }],
      ['GET', '/api/boards/b1/check', undefined]
    ])
  })

  it('stdout carries only protocol frames', async () => {
    // A token minted here, never a real one: it must not show up on either stream.
    const token = `wb_${randomBytes(32).toString('base64url')}`
    const child = spawn('pnpm', ['--silent', '--dir', repo, 'wirebender', 'mcp'], {
      env: { ...process.env, WIREBENDER_SERVER: 'http://127.0.0.1:9', WIREBENDER_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => void (stderr += d.toString()))
    const listed = new Promise<void>((resolve) => {
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
        if (stdout.includes('"id":2')) resolve()
      })
    })
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await listed
    const exited = new Promise<number | null>(resolve => child.on('exit', resolve))
    child.stdin.end()
    expect(await exited).toBe(0)

    const lines = stdout.split('\n').filter(l => l !== '')
    const frames = lines.map(l => JSON.parse(l) as { jsonrpc: string, id?: number, result?: { serverInfo?: { name: string }, tools?: unknown[] } })
    for (const f of frames) expect(f.jsonrpc).toBe('2.0')
    expect(frames.find(f => f.id === 1)?.result?.serverInfo?.name).toBe('wirebender')
    expect(frames.find(f => f.id === 2)?.result?.tools).toHaveLength(10)
    expect(stdout).not.toContain(token)
    expect(stderr).not.toContain(token)
  }, 30_000)
})
