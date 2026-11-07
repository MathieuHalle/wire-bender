/** The board id in a `/_ws/board/<id>` request URL, or `null` when it is missing or badly escaped. */
export function wsBoardId(url: string): string | null {
  try {
    const parts = new URL(url, 'http://localhost').pathname.split('/')
    if (parts.length !== 4 || parts[1] !== '_ws' || parts[2] !== 'board') return null
    const id = decodeURIComponent(parts[3]!)
    return id === '' ? null : id
  } catch {
    return null
  }
}
