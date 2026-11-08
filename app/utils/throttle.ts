/** The same warning shows again only after this long. */
export const SAME_MESSAGE_MS = 5000
/** Any two warnings are at least this far apart, so a burst shows one. */
export const ANY_MESSAGE_MS = 1500

/**
 * A notifier that drops repeats: going offline refuses every click, and each refusal would
 * otherwise stack another toast. A dropped message is not queued; the next one after the
 * pause shows.
 */
export function throttledNotify(show: (message: string) => void, now: () => number = Date.now): (message: string) => void {
  const lastShown = new Map<string, number>()
  let lastAny = -Infinity
  return (message) => {
    const t = now()
    if (t - (lastShown.get(message) ?? -Infinity) < SAME_MESSAGE_MS) return
    if (t - lastAny < ANY_MESSAGE_MS) return
    lastShown.set(message, t)
    lastAny = t
    show(message)
  }
}
