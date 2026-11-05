// Text rendering of a check result, shared by the CLI (and usable by the UI).
// Pure: no Node or DOM.
import type { AdjacencyLevel, CheckResult, Finding } from '~core/check'
import { ADVISORY } from '~core/advisory'

export { ADVISORY }

const CAUTION_LEVELS: AdjacencyLevel[] = ['supply', 'mcu', 'harmless']

export interface FindingGroup {
  /** `ERROR`, `WARNING` or `CAUTION [level]`. */
  tag: string
  findings: Finding[]
}

/** Findings in display order: errors, warnings, then cautions by level supply, mcu, harmless. */
export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups: FindingGroup[] = [
    { tag: 'ERROR', findings: findings.filter(f => f.severity === 'error') },
    { tag: 'WARNING', findings: findings.filter(f => f.severity === 'warning') },
    ...CAUTION_LEVELS.map(level => ({
      tag: `CAUTION [${level}]`,
      // A caution without a level is listed with the harmless ones.
      findings: findings.filter(f => f.severity === 'caution' && (f.level ?? 'harmless') === level)
    }))
  ]
  return groups.filter(g => g.findings.length)
}

export function statsLine(stats: CheckResult['stats']): string {
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`
  return `${n(stats.nets, 'net')}, ${n(stats.groups, 'group')}: ${n(stats.errors, 'error')}, `
    + `${n(stats.warnings, 'warning')}, ${n(stats.cautions, 'caution')}`
}

/** One line per finding, harmless cautions collapsed unless `all`, then stats, then the advisory. */
export function formatCheck(result: CheckResult, opts: { all?: boolean } = {}): string[] {
  const lines: string[] = []
  for (const g of groupFindings(result.findings)) {
    if (g.tag === 'CAUTION [harmless]' && !opts.all) {
      lines.push(`${g.tag} ${g.findings.length} more (use --all to list)`)
      continue
    }
    for (const f of g.findings) lines.push(`${g.tag} ${f.message}`)
  }
  lines.push(statsLine(result.stats), ADVISORY)
  return lines
}
