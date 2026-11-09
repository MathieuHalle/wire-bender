// Saves a big zip the server builds on request. A plain link would show the server's JSON
// refusal (the export is rate limited) as a page, so this fetches, then hands the bytes to
// the browser as a file. Returns the refusal text, or null when the file was saved.

/** The file name in a `Content-Disposition: attachment; filename="..."` header. */
export function dispositionName(header: string | null, fallback: string): string {
  const m = header ? /filename="([^"\\/]+)"/.exec(header) : null
  return m?.[1] ?? fallback
}

export async function saveZip(url: string, fallbackName: string): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/zip' } })
  } catch {
    return 'The server could not be reached.'
  }
  if (!res.ok) {
    if (res.status === 429) return 'Too many exports just now. Wait a minute and try again.'
    try {
      const j = await res.json() as { error?: unknown, message?: unknown }
      const m = typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : null
      if (m) return m
    } catch { /* not JSON */ }
    return `The download failed (HTTP ${res.status}).`
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = dispositionName(res.headers.get('content-disposition'), fallbackName)
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
  return null
}
