// Tokens that stop working (R7): revoked, or their user suspended, deleted or purged.
// Live sockets opened with them close at once, and their presence goes. No imports, so
// rooms, tokens and accounts may all use it without an import cycle.

const listeners = new Set<(ids: ReadonlySet<string>) => void>()

/** Called with the ids of tokens that just stopped working. */
export function onTokensRevoked(fn: (ids: ReadonlySet<string>) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Tell every listener that these tokens stopped working; nothing for none. */
export function tokensRevoked(ids: Iterable<string>): void {
  const set = new Set(ids)
  if (set.size === 0) return
  for (const fn of listeners) fn(set)
}
