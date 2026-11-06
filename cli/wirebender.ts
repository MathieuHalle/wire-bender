// WireBender CLI.
//   wirebender check <file> [--all] [--json]
//   wirebender export <file> [-o out.html]
// Exit codes: 0 no errors (export: written), 1 errors found, 2 file invalid or unreadable.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseBoard, type BoardFile } from '~core/schema'
import { runCheck } from '~core/check'
import { benchHtml } from '../export/benchHtml'
import { ADVISORY, formatCheck } from './format'

const USAGE = 'usage: wirebender check <file> [--all] [--json]\n       wirebender export <file> [-o out.html]'

/** Read and validate a board file; on failure print why (and the advisory) and return null. */
function loadBoard(file: string): { board: BoardFile, text: string } | null {
  let text: string
  let json: unknown
  try {
    text = readFileSync(file, 'utf8')
    json = JSON.parse(text)
  } catch (e) {
    console.log(`${file}: ${e instanceof Error ? e.message : String(e)}`)
    console.log(ADVISORY)
    return null
  }
  const parsed = parseBoard(json)
  if (!parsed.ok) {
    console.log(`${file}: not a valid board file`)
    for (const err of parsed.errors) console.log(err)
    console.log(ADVISORY)
    return null
  }
  return { board: parsed.board, text }
}

function check(args: string[]): number {
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const files = args.filter(a => !a.startsWith('--'))
  const unknown = [...flags].filter(f => f !== '--all' && f !== '--json')
  if (files.length !== 1 || unknown.length) {
    console.error(unknown.length ? `unknown option: ${unknown.join(', ')}\n${USAGE}` : USAGE)
    return 2
  }
  const loaded = loadBoard(files[0]!)
  if (!loaded) return 2

  const result = runCheck(loaded.board)
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2))
    console.error(ADVISORY) // stdout stays plain JSON
  } else for (const line of formatCheck(result, { all: flags.has('--all') })) console.log(line)
  return result.stats.errors > 0 ? 1 : 0
}

/** Write the bench sheet; default output `<basename>.bench.html` next to the board file. Never touches the board file. */
function exportCmd(args: string[]): number {
  const files: string[] = []
  let out: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-o' || a === '--out') {
      out = args[++i]
      if (out === undefined) {
        console.error(`${a} needs a file name\n${USAGE}`)
        return 2
      }
    } else if (a.startsWith('-')) {
      console.error(`unknown option: ${a}\n${USAGE}`)
      return 2
    } else files.push(a)
  }
  if (files.length !== 1) {
    console.error(USAGE)
    return 2
  }
  const file = files[0]!
  const loaded = loadBoard(file)
  if (!loaded) return 2
  const target = out ?? join(dirname(file), `${basename(file, extname(file))}.bench.html`)
  if (resolve(target) === resolve(file)) {
    console.error(`${target}: refusing to overwrite the board file`)
    return 2
  }
  const hash = createHash('sha256').update(loaded.text).digest('hex').slice(0, 12)
  try {
    writeFileSync(target, benchHtml(loaded.board, { hash }))
  } catch (e) {
    console.error(`${target}: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  console.log(target)
  return 0
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'check') process.exitCode = check(rest)
else if (cmd === 'export') process.exitCode = exportCmd(rest)
else {
  console.error(USAGE)
  process.exitCode = 2
}
