// `wirebender mcp`: an MCP server on stdio, so an AI client (Claude Code) can read and edit
// boards through the API with a token. stdout carries only the protocol; logs go to stderr
// and never hold the token.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ADVISORY } from '~core/advisory'
import { apiCall, configFrom } from './client'

/** One API call: what `apiCall` does, with the server and token already bound. */
export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number, json: unknown }>

type ToolResult = { content: { type: 'text', text: string }[], isError?: boolean }

const RULES = 'Edit a board by reading it with get_board first, then calling replace_board with baseRevision set to that read\'s head. '
  + 'A 409 means someone else changed the board in between: read it again with get_board, redo your change on the new board, and send it with the new head; never resend the old data. '
  + 'Check results are advisory: never claim a board is safe to power.'

const boardArg = z.string().min(1).describe('A board id (owner only) or a share link id')
const revisionArg = z.number().int().positive().describe('A revision number')
const dataArg = z.record(z.string(), z.unknown()).describe('A whole board file (JSON), as get_board returns it in `board`')

const text = (s: string, isError = false): ToolResult => isError ? { content: [{ type: 'text', text: s }], isError } : { content: [{ type: 'text', text: s }] }
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2))

/** The server's refusal, verbatim: `{ errors: [...] }`, `{ error }`, `{ reason }` or a message. */
function errorText(status: number, body: unknown): string {
  const j = (body ?? {}) as Record<string, unknown>
  if (Array.isArray(j.errors)) return j.errors.map(String).join('\n')
  for (const v of [j.error, j.reason, j.message, j.statusMessage]) if (typeof v === 'string' && v !== '') return v
  return `HTTP ${status}`
}

const board = (key: string) => `/api/boards/${encodeURIComponent(key)}`

/** The MCP server, its tools calling the API through `call`. */
export function createMcpServer(call: Call): McpServer {
  const server = new McpServer({ name: 'wirebender', version: '1.0.0' }, { instructions: RULES })

  /** Call the API; a 2xx answer becomes `ok(json)`, anything else a tool error with the server's text. */
  async function api(method: string, path: string, body?: unknown, ok: (j: unknown) => ToolResult = json): Promise<ToolResult> {
    const r = await call(method, path, body)
    return r.status >= 200 && r.status < 300 ? ok(r.json) : text(errorText(r.status, r.json), true)
  }

  server.registerTool('list_boards', {
    description: `List your boards: mine (default), shared with you, or in the trash. ${RULES}`,
    inputSchema: { list: z.enum(['mine', 'shared', 'trash']).optional() }
  }, ({ list }) => api('GET', `/api/boards?list=${list ?? 'mine'}`))

  server.registerTool('get_board', {
    description: `Read a board: { id, name, head, role, board }. head is the revision to pass as baseRevision to replace_board. ${RULES}`,
    inputSchema: { board: boardArg }
  }, ({ board: key }) => api('GET', board(key), undefined, (j) => {
    const { id, name, head, role, board: data } = j as Record<string, unknown>
    return json({ id, name, head, role, board: data })
  }))

  server.registerTool('replace_board', {
    description: `Replace a board with new board data, as one revision (needs the edit role). baseRevision is required: the head from your last get_board. On a 409 the board changed since: get_board again, redo your change on the new board, and send it with the new head. ${RULES}`,
    inputSchema: { board: boardArg, baseRevision: z.number().int().positive().describe('The head from the get_board this change is based on'), data: dataArg }
  }, async ({ board: key, baseRevision, data }) => {
    const r = await call('PUT', board(key), { baseRevision, board: data })
    if (r.status !== 409) return r.status >= 200 && r.status < 300 ? json(r.json) : text(errorText(r.status, r.json), true)
    let head = (r.json as { current?: unknown } | null)?.current
    if (typeof head !== 'number') {
      const fresh = await call('GET', board(key))
      head = (fresh.json as { head?: unknown } | null)?.head
    }
    return text(`The board changed since revision ${baseRevision}; read it again (head is ${typeof head === 'number' ? head : 'unknown'}) and redo your change.`, true)
  })

  server.registerTool('check_board', {
    description: `Run the board checks (findings and stats). The result is advisory only: never claim a board is safe to power. ${RULES}`,
    inputSchema: { board: boardArg }
  }, ({ board: key }) => api('GET', `${board(key)}/check`, undefined, j => text(`${JSON.stringify(j, null, 2)}\n${ADVISORY}`)))

  server.registerTool('list_revisions', {
    description: `List a board's revisions, newest last. ${RULES}`,
    inputSchema: { board: boardArg }
  }, ({ board: key }) => api('GET', `${board(key)}/revisions`))

  server.registerTool('get_revision', {
    description: `Read the board as it was at revision n. ${RULES}`,
    inputSchema: { board: boardArg, n: revisionArg }
  }, ({ board: key, n }) => api('GET', `${board(key)}/revisions/${n}`))

  server.registerTool('undo', {
    description: `Undo the board's last change, as a new revision (needs the edit role). ${RULES}`,
    inputSchema: { board: boardArg }
  }, ({ board: key }) => api('POST', `${board(key)}/undo`))

  server.registerTool('redo', {
    description: `Redo the change last undone, as a new revision (needs the edit role). ${RULES}`,
    inputSchema: { board: boardArg }
  }, ({ board: key }) => api('POST', `${board(key)}/redo`))

  server.registerTool('restore_revision', {
    description: `Make revision n the board's current state, as a new revision (needs the edit role). ${RULES}`,
    inputSchema: { board: boardArg, n: revisionArg }
  }, ({ board: key, n }) => api('POST', `${board(key)}/revisions/${n}/restore`))

  server.registerTool('create_board', {
    description: `Create a new board of yours from board data; returns its id. ${RULES}`,
    inputSchema: { data: dataArg }
  }, ({ data }) => api('POST', '/api/boards', { board: data }))

  return server
}

/** Run the server on stdio until stdin closes. */
export async function runMcp(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const cfg = configFrom(args, env)
  const server = createMcpServer((method, path, body) => apiCall(cfg, method, path, body))
  const transport = new StdioServerTransport()
  const closed = new Promise<void>(resolve => process.stdin.once('end', resolve))
  await server.connect(transport)
  console.error(`wirebender mcp: serving ${cfg.url} on stdio${cfg.token ? ' with a token' : ''}`)
  await closed
  await server.close()
  return 0
}
