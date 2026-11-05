// Rule logic ported from perfwire solver.py erc_audit/topology_audit, Apache-2.0
//
// The technical check: turns the board as drawn into findings in severity buckets.
// Rule groups live in core/check/*; this is the entry. It returns data only; whoever
// renders the findings ends the list with the advisory sentence.
import { parseHole } from './holes'
import type { BoardFile } from './schema'
import { buildContext, type Finding, type Severity } from './check/context'
import { netRules } from './check/nets'
import { placementRules } from './check/placement'
import { spacingRules } from './check/spacing'

export type { AdjacencyLevel, Finding, RuleId, Severity } from './check/context'

export interface CheckResult {
  findings: Finding[]
  stats: { nets: number, groups: number, errors: number, warnings: number, cautions: number }
}

const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'caution']

/** Row then column; holes that don't parse sort by name after those that do. */
function compareHoleNames(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
  try {
    const x = parseHole(a)
    const y = parseHole(b)
    return x.row - y.row || x.col - y.col
  } catch {
    return a.localeCompare(b)
  }
}

export function runCheck(board: BoardFile): CheckResult {
  const ctx = buildContext(board)
  const findings = [...netRules(ctx), ...placementRules(ctx), ...spacingRules(ctx)]
  findings.sort((a, b) =>
    SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
    || compareHoleNames(a.holes[0], b.holes[0]))

  const nets = new Set(ctx.leads.flatMap(l => l.net === null ? [] : [l.net]))
  const count = (s: Severity) => findings.filter(f => f.severity === s).length
  return {
    findings,
    stats: {
      nets: nets.size,
      groups: ctx.conn.groups.filter(g => g.leads.length > 0).length,
      errors: count('error'),
      warnings: count('warning'),
      cautions: count('caution')
    }
  }
}
