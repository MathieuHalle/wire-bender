/**
 * A request body as text, read chunk by chunk and abandoned as soon as it passes `max`
 * bytes (null then): a missing or false content-length cannot make the server buffer more.
 */
export async function readCapped(body: AsyncIterable<Buffer | string>, max: number): Promise<string | null> {
  return (await readCappedBytes(body, max))?.toString('utf8') ?? null
}

/** The same cap, for a binary body (a zip): the raw bytes, or null past `max`. */
export async function readCappedBytes(body: AsyncIterable<Buffer | string>, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += b.length
    if (size > max) return null
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}
