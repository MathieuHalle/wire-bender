import { z } from 'zod'
import { parseHole } from './holes'

export type HoleName = string
export type Side = 'top' | 'bottom'
export type PinRole = 'in' | 'out' | 'pwr' | 'oc' | 'passive'

export interface Part {
  ref: string
  footprint: string
  at: HoleName
  to?: HoleName
  rotation: 0 | 90 | 180 | 270
  flip?: boolean
  standing?: boolean
  value?: string
  label?: string
  pins: Record<string, string | null>
  roles?: Record<string, PinRole>
}
export interface Trail { id: string; side: Side; points: HoleName[]; joints: HoleName[] }
export interface Wire {
  id: string
  kind: 'laid' | 'flying'
  side: Side
  points: HoleName[]
  color?: string
  bareSegments: number[]
  joints: HoleName[]
}
export interface BoardFile {
  format: 'wirebender/1'
  revision: number
  name: string
  board: {
    cols: number
    rows: number
    pitchMm: number
    type: 'one-sided' | 'two-sided'
    blocked: { holes: HoleName[]; reason: string }[]
  }
  netClasses: Record<string, { color?: string }>
  nets: Record<string, { class?: string; color?: string }>
  rules: {
    keepAway: { a: string; b: string; holes: number }[]
    adjacency: { classes: [string, string]; level: 'supply' | 'mcu' }[]
  }
  parts: Part[]
  trails: Trail[]
  wires: Wire[]
  legFolds: { lead: string; to: HoleName }[]
  solderBridges: { side: Side; a: HoleName; b: HoleName }[]
  bench: { endLeadMm: number; bendAllowanceMm: number; spareMm: number; flyingSlackMm: number; roundToMm: number }
}

const hole = z.string()
const side = z.enum(['top', 'bottom'])
const role = z.enum(['in', 'out', 'pwr', 'oc', 'passive'])

const partSchema = z.strictObject({
  ref: z.string().min(1),
  footprint: z.string().min(1),
  at: hole,
  to: hole.optional(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  flip: z.boolean().optional(),
  standing: z.boolean().optional(),
  value: z.string().optional(),
  label: z.string().optional(),
  pins: z.record(z.string(), z.string().nullable()),
  roles: z.record(z.string(), role).optional()
})

const benchDefaults = { endLeadMm: 5, bendAllowanceMm: 1, spareMm: 5, flyingSlackMm: 10, roundToMm: 5 }

const boardFileSchema = z.strictObject({
  format: z.literal('wirebender/1'),
  revision: z.number().int().default(0),
  name: z.string(),
  board: z.strictObject({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    pitchMm: z.number().positive(),
    type: z.enum(['one-sided', 'two-sided']),
    blocked: z.array(z.strictObject({ holes: z.array(hole), reason: z.string() }))
  }),
  netClasses: z.record(z.string(), z.strictObject({ color: z.string().optional() })),
  nets: z.record(z.string(), z.strictObject({ class: z.string().optional(), color: z.string().optional() })),
  rules: z.strictObject({
    keepAway: z.array(z.strictObject({ a: z.string(), b: z.string(), holes: z.number().int().positive() })),
    adjacency: z.array(z.strictObject({ classes: z.tuple([z.string(), z.string()]), level: z.enum(['supply', 'mcu']) }))
  }),
  parts: z.array(partSchema),
  trails: z.array(z.strictObject({ id: z.string(), side, points: z.array(hole), joints: z.array(hole) })),
  wires: z.array(z.strictObject({
    id: z.string(),
    kind: z.enum(['laid', 'flying']),
    side,
    points: z.array(hole).min(2),
    color: z.string().optional(),
    bareSegments: z.array(z.number().int()),
    joints: z.array(hole)
  })),
  legFolds: z.array(z.strictObject({ lead: z.string(), to: hole })),
  solderBridges: z.array(z.strictObject({ side, a: hole, b: hole })),
  bench: z.strictObject({
    endLeadMm: z.number().default(benchDefaults.endLeadMm),
    bendAllowanceMm: z.number().default(benchDefaults.bendAllowanceMm),
    spareMm: z.number().default(benchDefaults.spareMm),
    flyingSlackMm: z.number().default(benchDefaults.flyingSlackMm),
    roundToMm: z.number().default(benchDefaults.roundToMm)
  }).default(benchDefaults)
})

export type ParseResult = { ok: true; board: BoardFile } | { ok: false; errors: string[] }

const fmtPath = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>((acc, p) => typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p), '')

/** A validation pass over a shape-valid board; returns error strings. */
type Check = (board: BoardFile) => string[]

function checkHoles(b: BoardFile): string[] {
  const errors: string[] = []
  const { cols, rows } = b.board
  const check = (path: string, name: string) => {
    try {
      const h = parseHole(name)
      if (h.col > cols || h.row > rows) errors.push(`${path}: hole ${name} is outside the ${cols} x ${rows} board`)
    } catch {
      errors.push(`${path}: bad hole name: ${name}`)
    }
  }
  b.board.blocked.forEach((bl, i) => bl.holes.forEach((n, j) => check(`board.blocked[${i}].holes[${j}]`, n)))
  b.parts.forEach((p, i) => {
    check(`parts[${i}].at`, p.at)
    if (p.to !== undefined) check(`parts[${i}].to`, p.to)
  })
  b.trails.forEach((t, i) => {
    t.points.forEach((n, j) => check(`trails[${i}].points[${j}]`, n))
    t.joints.forEach((n, j) => check(`trails[${i}].joints[${j}]`, n))
  })
  b.wires.forEach((w, i) => {
    w.points.forEach((n, j) => check(`wires[${i}].points[${j}]`, n))
    w.joints.forEach((n, j) => check(`wires[${i}].joints[${j}]`, n))
  })
  b.legFolds.forEach((f, i) => check(`legFolds[${i}].to`, f.to))
  b.solderBridges.forEach((s, i) => {
    check(`solderBridges[${i}].a`, s.a)
    check(`solderBridges[${i}].b`, s.b)
  })
  return errors
}

function checkStraight(b: BoardFile): string[] {
  const errors: string[] = []
  const walk = (prefix: string, points: HoleName[]) => {
    for (let j = 1; j < points.length; j++) {
      let a, c
      try {
        a = parseHole(points[j - 1]!)
        c = parseHole(points[j]!)
      } catch {
        continue // reported by checkHoles
      }
      if (a.col !== c.col && a.row !== c.row)
        errors.push(`${prefix}.points[${j}]: step ${points[j - 1]} -> ${points[j]} is not along a row or column`)
    }
  }
  b.trails.forEach((t, i) => walk(`trails[${i}]`, t.points))
  b.wires.forEach((w, i) => { if (w.kind !== 'flying') walk(`wires[${i}]`, w.points) })
  return errors
}

// Task 3 appends a footprint-exists check here.
const checks: Check[] = [checkHoles, checkStraight]

export function parseBoard(json: unknown): ParseResult {
  const res = boardFileSchema.safeParse(json)
  if (!res.success) {
    return { ok: false, errors: res.error.issues.map(i => `${fmtPath(i.path)}: ${i.message}`) }
  }
  const board = res.data as BoardFile
  const errors = checks.flatMap(c => c(board))
  if (errors.length) return { ok: false, errors }
  for (const p of board.parts)
    for (const net of Object.values(p.pins))
      if (net !== null && !(net in board.nets)) board.nets[net] = {}
  return { ok: true, board }
}
