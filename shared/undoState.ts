/** Replay a board's revision list (oldest first) into the tops of its undo and redo stacks. */
export function undoState(revs: { n: number, how: string, target: number | null }[]): { undo: number | null, redo: number | null } {
  let undo: number[] = []
  let redo: number[] = []
  for (const r of revs) {
    if (r.how === 'edit' || r.how === 'api' || r.how === 'restore' || r.how === 'recovered') {
      undo.push(r.n)
      redo = []
    } else if (r.how === 'undo' && r.target !== null) {
      undo = undo.filter(n => n !== r.target)
      redo.push(r.target)
    } else if (r.how === 'redo' && r.target !== null) {
      redo = redo.filter(n => n !== r.target)
      undo.push(r.target)
    }
  }
  return { undo: undo.at(-1) ?? null, redo: redo.at(-1) ?? null }
}
