// The CLI commands that talk to a server: import and pull. Never prints the token.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseBoard } from '~core/schema'
import { decodeBundle } from '~core/bundle'
import { apiBytes, apiCall, BOARD_KEY, configFrom, errorLines } from './client'
import { ADVISORY } from './format'

export const REMOTE_LINES = '       wirebender import <file or .wirebender.zip> [--url <server>] [--token <token>]\n       wirebender pull <board> -o <file> [--bundle] [--force] [--url <server>] [--token <token>]\n       (--url defaults to $WIREBENDER_SERVER or http://localhost:3000; --token to $WIREBENDER_TOKEN)'
export const REMOTE_USAGE = REMOTE_LINES.replace(/^\s+/, 'usage: ')

type Parsed = { positional: string[], out?: string, force: boolean, bundle: boolean, error?: string }

function parseArgs(args: string[], allowOut: boolean): Parsed {
  const p: Parsed = { positional: [], force: false, bundle: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--url' || a === '--token' || (allowOut && (a === '-o' || a === '--out'))) {
      const v = args[++i]
      if (v === undefined) return { ...p, error: `${a} needs a value` }
      if (a === '-o' || a === '--out') p.out = v
    } else if (a.startsWith('--url=') || a.startsWith('--token=')) continue
    else if (allowOut && a === '--force') p.force = true
    else if (allowOut && a === '--bundle') p.bundle = true
    else if (a.startsWith('-')) return { ...p, error: `unknown option: ${a}` }
    else p.positional.push(a)
  }
  return p
}

function fail(lines: string[]): number {
  for (const l of lines) console.error(l)
  return 1
}

export async function importCmd(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const p = parseArgs(args, false)
  if (p.error || p.positional.length !== 1) {
    console.error(p.error ? `${p.error}\n${REMOTE_USAGE}` : REMOTE_USAGE)
    return 2
  }
  const file = p.positional[0]!
  if (file.toLowerCase().endsWith('.zip')) return importBundle(file, args, env)
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.log(`${file}: ${e instanceof Error ? e.message : String(e)}`)
    console.log(ADVISORY)
    return 2
  }
  const parsed = parseBoard(json)
  if (!parsed.ok) {
    console.log(`${file}: not a valid board file`)
    for (const err of parsed.errors) console.log(err)
    console.log(ADVISORY)
    return 2
  }
  const cfg = configFrom(args, env)
  const r = await apiCall(cfg, 'POST', '/api/boards', { board: json })
  const id = (r.json as { id?: unknown } | null)?.id
  if (r.status !== 200 || typeof id !== 'string') return fail(errorLines(r.status, r.json))
  console.log(`imported ${parsed.board.name} → ${cfg.url}/b/${id}`)
  return 0
}

async function importBundle(file: string, args: string[], env: Record<string, string | undefined>): Promise<number> {
  let zip: Uint8Array
  try {
    zip = new Uint8Array(readFileSync(file))
  } catch (e) {
    console.log(`${file}: ${e instanceof Error ? e.message : String(e)}`)
    console.log(ADVISORY)
    return 2
  }
  const dec = decodeBundle(zip, { maxBoardBytes: 2_000_000 })
  if (!dec.ok) {
    console.log(`${file}: not a valid board bundle`)
    console.log(dec.error)
    console.log(ADVISORY)
    return 2
  }
  const cfg = configFrom(args, env)
  const r = await apiBytes(cfg, 'POST', '/api/boards/import-bundle', zip)
  const j = r.json as { id?: unknown, name?: unknown, revisions?: unknown } | null
  if (r.status !== 201 || typeof j?.id !== 'string') return fail(errorLines(r.status, r.json))
  const n = typeof j.revisions === 'number' ? j.revisions : dec.bundle.revisions.length
  console.log(`imported ${typeof j.name === 'string' ? j.name : dec.bundle.name} (${n} revision${n === 1 ? '' : 's'}) → ${cfg.url}/b/${j.id}`)
  return 0
}

export async function pullCmd(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const p = parseArgs(args, true)
  if (p.error || p.positional.length !== 1 || (p.out === undefined && !p.bundle)) {
    console.error(p.error ? `${p.error}\n${REMOTE_USAGE}` : REMOTE_USAGE)
    return 2
  }
  if (!BOARD_KEY.test(p.positional[0]!)) {
    console.error('A board key is letters, digits, - and _ only.')
    return 2
  }
  const out = p.out ?? `${p.positional[0]}.wirebender.zip`
  if (existsSync(out) && !p.force) {
    console.error(`${out} exists; add --force to overwrite`)
    return 2
  }
  const cfg = configFrom(args, env)
  if (p.bundle) {
    const b = await apiBytes(cfg, 'GET', `/api/boards/${encodeURIComponent(p.positional[0]!)}/bundle`)
    if (b.status !== 200) return fail(errorLines(b.status, b.json))
    try {
      writeFileSync(out, b.bytes)
    } catch (e) {
      console.error(`${out}: ${e instanceof Error ? e.message : String(e)}`)
      return 2
    }
    console.log(out)
    return 0
  }
  const r = await apiCall(cfg, 'GET', `/api/boards/${encodeURIComponent(p.positional[0]!)}`)
  const board = (r.json as { board?: unknown } | null)?.board
  if (r.status !== 200 || board === undefined) return fail(errorLines(r.status, r.json))
  try {
    writeFileSync(out, `${JSON.stringify(board, null, 2)}\n`)
  } catch (e) {
    console.error(`${out}: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  console.log(out)
  return 0
}
