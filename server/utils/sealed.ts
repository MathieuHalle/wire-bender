// A link password kept so its owner can see it again (the hash alone can only check it).
// AES-256-GCM with a key derived from the session secret: a copy of the database alone does
// not give the passwords away, and a new secret makes the old copies unreadable (the owner
// sets the password again to see it; the hash keeps working).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const INFO = 'wirebender link password v1'
const VERSION = 'v1'

/** The key link passwords are sealed with, from the session secret. */
export function sealKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', INFO, 32))
}

/** `v1.<iv>.<tag>.<ciphertext>`, base64url. */
export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [VERSION, iv, c.getAuthTag(), body].map(p => typeof p === 'string' ? p : p.toString('base64url')).join('.')
}

/** The password, or null when it was sealed with another key or is not a sealed value. */
export function unseal(key: Buffer, sealed: string): string | null {
  const [v, iv, tag, body, ...rest] = sealed.split('.')
  if (v !== VERSION || !iv || !tag || body === undefined || rest.length > 0) return null
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8')
  } catch {
    return null
  }
}
