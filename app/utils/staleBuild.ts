// A page open across a redeploy asks for code files the new build no longer has. Each browser
// words that failure its own way; these are the wordings. Pure: no Vue.
const STALE = [
  /Importing a module script failed/i, // Safari
  /Failed to fetch dynamically imported module/i, // Chrome
  /error loading dynamically imported module/i, // Firefox
  /Unable to preload CSS/i, // Vite's CSS preload
  /Loading (CSS )?chunk \S+ failed/i
]

/** True when `error` is a code file that failed to load: most likely WireBender was updated. */
export function isStaleBuild(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return STALE.some(r => r.test(message))
}

export const UPDATED = { title: 'WireBender was updated.', description: 'Reload the page to use the new version.' }
