/** A colour from the board file, or the fallback when it is not a plain colour (hex or a name). */
export function safeColor(c: string | null | undefined, fallback: string): string {
  if (!c) return fallback
  return /^#[0-9a-f]{3,8}$/i.test(c) || /^[a-z]{3,20}$/i.test(c) ? c : fallback
}
