// What the server needs before it starts: its mode (spec §3), set by WIREBENDER_MODE and
// never guessed, and the session secret. Kept apart from who.ts: the dev modules
// (modules/*.ts) use these too, outside Nitro.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { IDENTITY_PROVIDERS } from '../db/schema'

type Provider = typeof IDENTITY_PROVIDERS[number]

export type Mode = 'local' | 'public'

export const MODE_ERRORS = {
  mode: 'WIREBENDER_MODE must be local or public',
  url: 'public mode needs WIREBENDER_URL, the address people use to reach this server',
  provider: 'public mode needs a sign-in provider: set NUXT_OAUTH_GITHUB_CLIENT_ID and NUXT_OAUTH_GITHUB_CLIENT_SECRET, or the Google pair'
} as const

type Env = Record<string, string | undefined>

const PROVIDER_ENV: Record<Provider, [string, string]> = {
  github: ['NUXT_OAUTH_GITHUB_CLIENT_ID', 'NUXT_OAUTH_GITHUB_CLIENT_SECRET'],
  google: ['NUXT_OAUTH_GOOGLE_CLIENT_ID', 'NUXT_OAUTH_GOOGLE_CLIENT_SECRET']
}

/** The providers whose client id and secret are both set. */
export function configuredProviders(env: Env = process.env): Provider[] {
  return (Object.keys(PROVIDER_ENV) as Provider[]).filter(p => PROVIDER_ENV[p].every(k => !!env[k]))
}

/** `WIREBENDER_URL` if it is an http(s) URL, else null. */
export function publicUrl(env: Env = process.env): URL | null {
  const raw = env.WIREBENDER_URL
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

/** The server's mode; throws (the server stops) with the exact Global Constraints message when it can't run. */
export function checkMode(env: Env = process.env): Mode {
  const mode = env.WIREBENDER_MODE
  if (mode !== 'local' && mode !== 'public') throw new Error(MODE_ERRORS.mode)
  if (mode === 'public') {
    if (!publicUrl(env)) throw new Error(MODE_ERRORS.url)
    if (configuredProviders(env).length === 0) throw new Error(MODE_ERRORS.provider)
  }
  return mode
}

const MIN_SECRET = 32
export const SECRET_FILE = 'session-secret'

/**
 * The secret sessions are sealed with: `NUXT_SESSION_PASSWORD` when set, else
 * `<data>/session-secret`, made once (32 random bytes, hex, mode 0600) and reused, so
 * sessions survive restarts. A file that is there but unusable is refused, never replaced.
 *
 * nuxt-auth-utils 0.6 seals sessions with a key derived from Nuxt's `appSecret`, which Nitro
 * reads from `NUXT_APP_SECRET` once, when the server loads: this secret must be in that
 * variable before the server process starts (modules/session-secret.ts does it for `nuxt dev`).
 */
export function sessionSecret(dataDir: string, env: Env = process.env): string {
  const given = env.NUXT_SESSION_PASSWORD
  if (given) {
    if (given.length < MIN_SECRET) throw new Error(`NUXT_SESSION_PASSWORD must be at least ${MIN_SECRET} characters`)
    return given
  }
  mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, SECRET_FILE)
  let text: string | null = null
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (text === null) {
    const secret = randomBytes(32).toString('hex')
    // `wx`: if another process made it first, this fails instead of replacing it.
    writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' })
    return secret
  }
  const secret = text.trim()
  if (secret.length < MIN_SECRET || /\s/.test(secret)) throw new Error(`${file} is not a usable session secret (at least ${MIN_SECRET} characters); move it away to make a new one`)
  return secret
}

export const SECRET_ERROR = 'public mode needs NUXT_APP_SECRET set to the session secret when the server starts: NUXT_SESSION_PASSWORD if set, else the contents of <data>/session-secret (pnpm dev sets it itself)'

/** At start: in public mode, sessions must be sealed with the session secret, not some other `appSecret`. */
export function secretProblem(mode: Mode, appSecret: unknown, secret: string): string | null {
  return mode === 'public' && appSecret !== secret ? SECRET_ERROR : null
}
