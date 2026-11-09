// Writes docs/format/wirebender-1.schema.json from the zod schema: `pnpm schema`.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { boardFileSchema } from '~core/schema'

const out = fileURLToPath(new URL('../docs/format/wirebender-1.schema.json', import.meta.url))
const schema = { title: 'WireBender board, wirebender/1', ...z.toJSONSchema(boardFileSchema, { io: 'input' }) }
writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`)
console.log(`wrote ${out}`)
