import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { boardFileSchema, parseBoard } from '~core/schema'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../docs/format/${rel}`, import.meta.url)), 'utf8')

describe('format docs', () => {
  it('the committed JSON Schema matches the generated one', () => {
    const generated = `${JSON.stringify({ title: 'WireBender board, wirebender/1', ...z.toJSONSchema(boardFileSchema) }, null, 2)}\n`
    expect(read('wirebender-1.schema.json'), 'docs/format/wirebender-1.schema.json is out of date: run `pnpm schema`').toBe(generated)
  })

  it.each(['minimal.wirebender.json', 'channel-board-2.wirebender.json'])('example board %s passes parseBoard', (name) => {
    const res = parseBoard(JSON.parse(read(`examples/${name}`)))
    expect(res.ok, res.ok ? '' : res.errors.join('\n')).toBe(true)
  })

  it('the spec page names every top-level field of the schema', () => {
    const page = read('wirebender-1.md')
    const keys = Object.keys((JSON.parse(read('wirebender-1.schema.json')) as { properties: object }).properties)
    expect(keys.length).toBeGreaterThan(10)
    for (const k of keys) expect(page, `the page never names \`${k}\``).toContain(`\`${k}\``)
  })
})
