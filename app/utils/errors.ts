// What a failed `$fetch` says, for the dashboard pages. Pure: no Vue.

/** The errors of a failed request: the API's 422 list, or its message. */
export function errorsOf(e: unknown): string[] {
  const data = (e as { data?: { errors?: unknown, error?: unknown } }).data
  if (Array.isArray(data?.errors)) return data.errors.map(String)
  if (typeof data?.error === 'string') return [data.error]
  return [(e as Error).message]
}
