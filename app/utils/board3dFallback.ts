// What the 3D view shows instead of the board when it cannot draw: WebGL is off, or the
// view failed (the chunk did not load, or the WebGL renderer threw). A chunk gone after a
// redeploy says so and offers a reload.
import { isStaleBuild, UPDATED } from './staleBuild'

export type Board3DFailure = { kind: 'no-webgl' } | { kind: 'error', error?: unknown }

export function fallbackAlert(f: Board3DFailure): { title: string, description?: string, reload?: true } {
  if (f.kind === 'no-webgl') return { title: '3D view needs WebGL, which this browser has turned off.' }
  const e = f.error
  if (isStaleBuild(e)) return { ...UPDATED, reload: true }
  const reason = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return reason ? { title: 'The 3D view failed to start.', description: reason } : { title: 'The 3D view failed to start.' }
}
