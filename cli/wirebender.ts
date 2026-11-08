// WireBender CLI.
//   wirebender check <file> [--all] [--json]
//   wirebender export <file> [-o out.html] [--flip lr|tb]
//   wirebender import <file> | pull <board> -o <file>   (against a server)
// Exit codes: 0 no errors (export: written), 1 errors found, 2 file invalid or unreadable.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseBoard, type BoardFile } from '~core/schema'
import { runCheck } from '~core/check'
import { parseFlip, type Flip } from '~core/sideView'
import { benchHtml, tickKey } from '../export/benchHtml'
import { ADVISORY, formatCheck } from './format'
import { REMOTE_LINES, importCmd, pullCmd } from './commands'

const USAGE = 'usage: wirebender check <file> [--all] [--json]\n       wirebender export <file> [-o out.html] [--flip lr|tb]\n' + REMOTE_LINES

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
  let flip: Flip = 'lr'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-o' || a === '--out') {
      out = args[++i]
      if (out === undefined) {
        console.error(`${a} needs a file name\n${USAGE}`)
        return 2
      }
    } else if (a === '--flip') {
      const v = args[++i]
      if (v === undefined) {
        console.error(`--flip needs lr or tb\n${USAGE}`)
        return 2
      }
      const f = parseFlip(v)
      if (!f) {
        console.error(`--flip must be lr or tb, not "${v}"\n${USAGE}`)
        return 2
      }
      flip = f
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
  const hash = tickKey(createHash('sha256').update(loaded.text).digest('hex'))
  try {
    writeFileSync(target, benchHtml(loaded.board, { hash, flip }))
  } catch (e) {
    console.error(`${target}: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  console.log(target)
  // The sheet still gets written (exit 0); say so where a script will see it.
  const errors = runCheck(loaded.board).stats.errors
  if (errors > 0) console.error(`board has ${errors} error${errors === 1 ? '' : 's'} — see the red box on the sheet`)
  return 0
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'check') process.exitCode = check(rest)
else if (cmd === 'export') process.exitCode = exportCmd(rest)
else if (cmd === 'import') process.exitCode = await importCmd(rest)
else if (cmd === 'pull') process.exitCode = await pullCmd(rest)
else {
  console.error(USAGE)
  process.exitCode = 2
}
