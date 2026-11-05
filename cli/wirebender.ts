// WireBender CLI.
//   wirebender check <file> [--all] [--json]
// Exit codes: 0 no errors, 1 errors found, 2 file invalid or unreadable.
import { readFileSync } from 'node:fs'
import { parseBoard } from '~core/schema'
import { runCheck } from '~core/check'
import { ADVISORY, formatCheck } from './format'

const USAGE = 'usage: wirebender check <file> [--all] [--json]'

function check(args: string[]): number {
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const files = args.filter(a => !a.startsWith('--'))
  const unknown = [...flags].filter(f => f !== '--all' && f !== '--json')
  if (files.length !== 1 || unknown.length) {
    console.error(unknown.length ? `unknown option: ${unknown.join(', ')}\n${USAGE}` : USAGE)
    return 2
  }
  const file = files[0]!

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

  const result = runCheck(parsed.board)
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2))
    console.error(ADVISORY) // stdout stays plain JSON
  } else for (const line of formatCheck(result, { all: flags.has('--all') })) console.log(line)
  return result.stats.errors > 0 ? 1 : 0
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'check') process.exitCode = check(rest)
else {
  console.error(USAGE)
  process.exitCode = 2
}
