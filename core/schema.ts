import { z } from 'zod'
import { holeKey as holeKeyOf, holeName as holeNameOf, parseHole } from './holes'
import { FOOTPRINTS } from './footprints'
import { existingHoles, outlineIsSimple } from './boardShape'
import { stripHoles, stripIndex } from './strips'

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
export interface Trail { id: string, side: Side, points: HoleName[], joints: HoleName[] }
export interface Wire {
  id: string
  kind: 'laid' | 'flying'
  side: Side
  points: HoleName[]
  color?: string
  bareSegments: number[]
  joints: HoleName[]
}
export type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'
/** A corner cut `holes` deep: a 45° chamfer, or a square notch. */
export interface CornerCut { cut: 'chamfer' | 'notch', holes: number }
/** A board that is not a plain rectangle: round, or with cut corners (as seen from the top). */
/**
 * A board that is not a plain rectangle: round, with cut corners (as seen from the top), or
 * `strips`: only the holes on a strip exist (a breadboard's gaps and channel).
 */
export type BoardShape = { kind: 'round' } | { kind: 'corners', corners: Partial<Record<Corner, CornerCut>> } | { kind: 'strips' }
export interface BoardFile {
  format: 'wirebender/1'
  revision: number
  name: string
  board: {
    cols: number
    rows: number
    pitchMm: number
    /** `breadboard`: parts and jumpers plug in, nothing is soldered; the strips are its clips. */
    type: 'one-sided' | 'two-sided' | 'breadboard'
    blocked: { holes: HoleName[], reason: string }[]
    /** Absent: the full `cols × rows` rectangle. Holes outside the shape are missing (`core/boardShape.ts`). */
    shape?: BoardShape
    /** Copper the board comes with, each a straight run along a row or a column (`core/strips.ts`). */
    strips?: { from: HoleName, to: HoleName, skip?: HoleName[] }[]
    /** Display only: the printed name of each row (`""` for none), as on a breadboard's print. */
    rowLabels?: string[]
  }
  netClasses: Record<string, { color?: string }>
  nets: Record<string, { class?: string, color?: string }>
  rules: {
    keepAway: { a: string, b: string, holes: number }[]
    adjacency: { classes: [string, string], level: 'supply' | 'mcu' }[]
  }
  parts: Part[]
  trails: Trail[]
  wires: Wire[]
  legFolds: { lead: string, to: HoleName }[]
  solderBridges: { side: Side, a: HoleName, b: HoleName }[]
  /** A stripboard's cuts: the copper around each of these strip holes is removed, splitting the strip. */
  cuts?: HoleName[]
  bench: {
    endLeadMm: number
    bendAllowanceMm: number
    spareMm: number
    flyingSlackMm: number
    roundToMm: number
    /** Print paper for the bench export. */
    paper: 'letter' | 'a4'
  }
}

const hole = z.string()
const side = z.enum(['top', 'bottom'])
const role = z.enum(['in', 'out', 'pwr', 'oc', 'passive'])
const cornerCut = z.strictObject({ cut: z.enum(['chamfer', 'notch']), holes: z.number().int().positive() })
const boardShape = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('round') }),
  z.strictObject({
    kind: z.literal('corners'),
    corners: z.strictObject({
      topLeft: cornerCut.optional(),
      topRight: cornerCut.optional(),
      bottomLeft: cornerCut.optional(),
      bottomRight: cornerCut.optional()
    })
  }),
  z.strictObject({ kind: z.literal('strips') })
])

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

const benchDefaults = { endLeadMm: 5, bendAllowanceMm: 1, spareMm: 5, flyingSlackMm: 10, roundToMm: 5, paper: 'letter' as const }
/** The bench settings a board gets when its file leaves them out. */
export const BENCH_DEFAULTS: Readonly<typeof benchDefaults> = benchDefaults

export const boardFileSchema = z.strictObject({
  format: z.literal('wirebender/1'),
  revision: z.number().int().default(0),
  name: z.string(),
  board: z.strictObject({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    pitchMm: z.number().positive(),
    type: z.enum(['one-sided', 'two-sided', 'breadboard']),
    blocked: z.array(z.strictObject({ holes: z.array(hole), reason: z.string() })),
    shape: boardShape.optional(),
    strips: z.array(z.strictObject({ from: hole, to: hole, skip: z.array(hole).optional() })).optional(),
    rowLabels: z.array(z.string()).optional()
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
  cuts: z.array(hole).optional(),
  bench: z.strictObject({
    endLeadMm: z.number().nonnegative().default(benchDefaults.endLeadMm),
    bendAllowanceMm: z.number().nonnegative().default(benchDefaults.bendAllowanceMm),
    spareMm: z.number().nonnegative().default(benchDefaults.spareMm),
    flyingSlackMm: z.number().nonnegative().default(benchDefaults.flyingSlackMm),
    roundToMm: z.number().positive().default(benchDefaults.roundToMm),
    paper: z.enum(['letter', 'a4']).default(benchDefaults.paper)
  }).default(benchDefaults)
})

export type ParseResult = { ok: true, board: BoardFile } | { ok: false, errors: string[] }

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
  b.board.strips?.forEach((st, i) => {
    check(`board.strips[${i}].from`, st.from)
    check(`board.strips[${i}].to`, st.to)
    st.skip?.forEach((n, j) => check(`board.strips[${i}].skip[${j}]`, n))
  })
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
  b.cuts?.forEach((n, i) => check(`cuts[${i}]`, n))
  b.solderBridges.forEach((s, i) => {
    check(`solderBridges[${i}].a`, s.a)
    check(`solderBridges[${i}].b`, s.b)
  })
  return errors
}

/**
 * A shape must leave holes: a round board needs one (1 wide and an even number long has none),
 * corners must name a cut, two cuts on one edge must leave a hole on it, and cuts on opposite
 * corners may not split the board.
 */
function checkShape(b: BoardFile): string[] {
  const s = b.board.shape
  if (s?.kind === 'round' && existingHoles(b.board).length === 0)
    return [`board.shape: a round ${b.board.cols} × ${b.board.rows} board has no hole`]
  if (s?.kind !== 'corners') return []
  if (!Object.values(s.corners).some(Boolean)) return ['board.shape: corners names no corner cut (leave shape out for a rectangle)']
  const n = (c: Corner) => s.corners[c]?.holes ?? 0
  const { cols, rows } = b.board
  const edges: [string, Corner, Corner, number][] = [
    ['top', 'topLeft', 'topRight', cols],
    ['bottom', 'bottomLeft', 'bottomRight', cols],
    ['left', 'topLeft', 'bottomLeft', rows],
    ['right', 'topRight', 'bottomRight', rows]
  ]
  const errors = edges
    .filter(([, a, c, size]) => n(a) + n(c) >= size)
    .map(([edge, a, c, size]) => `board.shape: the ${edge} edge's corner cuts leave no hole (${n(a)} + ${n(c)} of ${size})`)
  if (errors.length) return errors
  // Cuts on opposite corners may not overlap or meet: the board would come apart in pieces.
  for (const [a, c] of [['topLeft', 'bottomRight'], ['topRight', 'bottomLeft']] as [Corner, Corner][]) {
    const pair = { [a]: s.corners[a], [c]: s.corners[c] }
    if (s.corners[a] && s.corners[c] && !outlineIsSimple({ ...b.board, shape: { kind: 'corners', corners: pair } }))
      errors.push(`board.shape: the ${a} and ${c} corner cuts overlap or meet, splitting the board`)
  }
  return errors
}

/**
 * Strips run along one row or one column and don't share a hole; the `strips` shape needs a strip;
 * a breadboard has strips.
 */
function checkStrips(b: BoardFile): string[] {
  const errors: string[] = []
  const strips = b.board.strips ?? []
  const owner = new Map<string, number>()
  strips.forEach((st, i) => {
    let hs
    try {
      hs = stripHoles(st)
    } catch {
      return // reported by checkHoles
    }
    if (!hs.length) {
      errors.push(`board.strips[${i}]: ${st.from} to ${st.to} is not along one row or column`)
      return
    }
    const inner = new Set(hs.slice(1, -1).map(holeNameOf))
    st.skip?.forEach((n, j) => {
      if (!inner.has(n)) errors.push(`board.strips[${i}].skip[${j}]: ${n} is not between ${st.from} and ${st.to}`)
    })
    for (const h of hs) {
      const name = `${h.col}|${h.row}`
      const other = owner.get(name)
      if (other !== undefined) {
        errors.push(`board.strips[${i}]: shares ${holeNameOf(h)} with board.strips[${other}]`)
        return
      }
      owner.set(name, i)
    }
  })
  if (b.board.shape?.kind === 'strips' && !strips.length) errors.push('board.shape: strips names no strip')
  // Cuts: on a drilled strip hole, once each; a breadboard is never cut.
  const drilled = stripIndex(b.board)
  const seen = new Set<string>()
  b.cuts?.forEach((n, i) => {
    if (b.board.type === 'breadboard') errors.push(`cuts[${i}]: a breadboard's clips can't be cut`)
    else if (seen.has(n)) errors.push(`cuts[${i}]: duplicate ${n}`)
    else {
      try {
        if (!drilled.has(holeKeyOf(parseHole(n)))) errors.push(`cuts[${i}]: ${n} is not on a strip`)
      } catch {
        // a bad name: reported by checkHoles
      }
    }
    seen.add(n)
  })
  if (b.board.type === 'breadboard' && !strips.length) errors.push('board.strips: a breadboard has no strips')
  return errors
}

/**
 * One label per row, never a grid row's own letters (`A`, `AB`). Labels may repeat: a
 * breadboard prints `+` and `-` on both pairs of rails (a repeated label is shown with its grid name).
 */
function checkRowLabels(b: BoardFile): string[] {
  const labels = b.board.rowLabels
  if (!labels) return []
  if (labels.length !== b.board.rows) return [`board.rowLabels: ${labels.length} labels for ${b.board.rows} rows`]
  const errors: string[] = []
  labels.forEach((l, i) => {
    if (/^[A-Z]+$/.test(l)) errors.push(`board.rowLabels[${i}]: "${l}" looks like a grid row name`)
  })
  return errors
}

/** Nothing is soldered on a breadboard: no trails, folds, bridges, joints or bare wire; wires on top. */
function checkBreadboard(b: BoardFile): string[] {
  if (b.board.type !== 'breadboard') return []
  const errors: string[] = []
  const no = 'a breadboard has no solder'
  b.trails.forEach((_, i) => errors.push(`trails[${i}]: ${no} (trails)`))
  b.legFolds.forEach((_, i) => errors.push(`legFolds[${i}]: ${no} (leg folds)`))
  b.solderBridges.forEach((_, i) => errors.push(`solderBridges[${i}]: ${no} (solder bridges)`))
  b.wires.forEach((w, i) => {
    if (w.side !== 'top') errors.push(`wires[${i}].side: a breadboard's jumpers are on the top`)
    if (w.joints.length) errors.push(`wires[${i}].joints: ${no} (joints)`)
    if (w.bareSegments.length) errors.push(`wires[${i}].bareSegments: ${no} (bare wire)`)
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
  b.wires.forEach((w, i) => {
    if (w.kind !== 'flying') walk(`wires[${i}]`, w.points)
  })
  return errors
}

function checkFootprints(b: BoardFile): string[] {
  const errors: string[] = []
  b.parts.forEach((p, i) => {
    if (!Object.hasOwn(FOOTPRINTS, p.footprint)) errors.push(`parts[${i}].footprint: unknown "${p.footprint}"`)
  })
  return errors
}

/** Part refs are unique; trail and wire ids are unique together (connectivity joins by id). */
function checkUnique(b: BoardFile): string[] {
  const errors: string[] = []
  const refs = new Set<string>()
  b.parts.forEach((p, i) => {
    if (refs.has(p.ref)) errors.push(`parts[${i}].ref: duplicate "${p.ref}"`)
    refs.add(p.ref)
  })
  const ids = new Set<string>()
  const see = (path: string, id: string) => {
    if (ids.has(id)) errors.push(`${path}.id: duplicate "${id}"`)
    ids.add(id)
  }
  b.trails.forEach((t, i) => see(`trails[${i}]`, t.id))
  b.wires.forEach((w, i) => see(`wires[${i}]`, w.id))
  return errors
}

/**
 * A one-sided board has no top pads: a top-side trail (bare, soldered only at joints) or
 * a top-side wire joint can never be soldered. Top-side wires themselves are fine (their
 * ends go down through the holes).
 */
function checkTopSide(b: BoardFile): string[] {
  if (b.board.type !== 'one-sided') return []
  const errors: string[] = []
  const msg = 'this board has no pads on the top side'
  b.trails.forEach((t, i) => {
    if (t.side === 'top') errors.push(`trails[${i}].side: ${msg}`)
  })
  b.wires.forEach((w, i) => {
    if (w.side === 'top') w.joints.forEach((_, j) => errors.push(`wires[${i}].joints[${j}]: ${msg}`))
  })
  return errors
}

const checks: Check[] = [checkHoles, checkShape, checkStrips, checkRowLabels, checkBreadboard, checkStraight, checkFootprints, checkUnique, checkTopSide]

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
