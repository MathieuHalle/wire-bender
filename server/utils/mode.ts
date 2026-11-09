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

/**
 * Where share links point: `WIREBENDER_URL` in public mode, without a trailing slash, or
 * null in local mode (which offers no sharing).
 */
export function publicBase(env: Env = process.env): string | null {
  if (checkMode(env) !== 'public') return null
  return publicUrl(env)?.href.replace(/\/+$/, '') ?? null
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

export interface SessionSecret {
  secret: string
  from: 'NUXT_APP_SECRET' | 'NUXT_SESSION_PASSWORD' | 'file'
  /** `<data>/session-secret`, whether or not it was used. */
  file: string
}

function fromEnv(env: Env, name: 'NUXT_APP_SECRET' | 'NUXT_SESSION_PASSWORD'): string | undefined {
  const given = env[name]
  if (!given) return undefined
  if (given.length < MIN_SECRET) throw new Error(`${name} must be at least ${MIN_SECRET} characters`)
  if (given.trimStart().toLowerCase().startsWith('replace-me')) throw new Error(`${name} is still the placeholder from .env.example: set it to the output of openssl rand -hex 32`)
  return given
}

/**
 * The secret sessions are sealed with, in this order: `NUXT_APP_SECRET`,
 * `NUXT_SESSION_PASSWORD`, else `<data>/session-secret`, made once (32 random bytes, hex,
 * mode 0600) and reused, so sessions survive restarts. A file that is there but unusable
 * is refused, never replaced. Public mode only: local mode reads no session.
 *
 * nuxt-auth-utils 0.6 seals sessions with a key derived from Nuxt's `appSecret`, which Nitro
 * reads from `NUXT_APP_SECRET` once, when the server loads: this secret must be in that
 * variable before the server process starts (modules/session-secret.ts does it for `nuxt dev`).
 *
 * With `create` false (a production start) a missing file is not made: null instead.
 */
export function resolveSessionSecret(dataDir: string, env?: Env): SessionSecret
export function resolveSessionSecret(dataDir: string, env: Env, create: false): SessionSecret | null
export function resolveSessionSecret(dataDir: string, env: Env = process.env, create = true): SessionSecret | null {
  const file = path.join(dataDir, SECRET_FILE)
  const app = fromEnv(env, 'NUXT_APP_SECRET')
  if (app) return { secret: app, from: 'NUXT_APP_SECRET', file }
  const password = fromEnv(env, 'NUXT_SESSION_PASSWORD')
  if (password) return { secret: password, from: 'NUXT_SESSION_PASSWORD', file }
  let text: string | null = null
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (text === null) {
    if (!create) return null
    mkdirSync(dataDir, { recursive: true })
    const secret = randomBytes(32).toString('hex')
    // `wx`: if another process made it first, this fails instead of replacing it.
    writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' })
    return { secret, from: 'file', file }
  }
  const secret = text.trim()
  if (secret.length < MIN_SECRET || /\s/.test(secret)) throw new Error(`${file} is not a usable session secret (at least ${MIN_SECRET} characters); move it away to make a new one`)
  return { secret, from: 'file', file }
}

export function sessionSecret(dataDir: string, env: Env = process.env): string {
  return resolveSessionSecret(dataDir, env).secret
}

const SECRET_NEEDED = 'public mode needs NUXT_APP_SECRET set to the session secret when the server starts'

/**
 * At start. Local mode: nothing (no file, never an error). Public mode: the error to stop
 * with when sessions would be sealed with another `appSecret` (a build started without
 * `NUXT_APP_SECRET`), naming the exact fix; else null. No session-secret file is ever made
 * here: with no secret at all, the fix is a new one from openssl. A file made earlier (by
 * `pnpm dev:public`) is pointed at instead, so its sessions survive.
 */
export function startupSecretProblem(mode: Mode, appSecret: unknown, dataDir: string, env: Env = process.env): string | null {
  if (mode === 'local') return null
  const s = resolveSessionSecret(dataDir, env, false)
  if (s === null) return `${SECRET_NEEDED}: set NUXT_APP_SECRET to the output of openssl rand -hex 32`
  if (appSecret === s.secret) return null
  return s.from === 'file'
    ? `${SECRET_NEEDED}: NUXT_APP_SECRET=$(cat ${s.file})`
    : `${SECRET_NEEDED}: NUXT_APP_SECRET="$NUXT_SESSION_PASSWORD"`
}

/** `nuxt dev`: the NUXT_APP_SECRET to hand the worker; none in local mode (Nuxt's own dev secret is left alone). */
export function devAppSecret(mode: Mode, dataDir: string, env: Env = process.env): string | undefined {
  return mode === 'public' ? sessionSecret(dataDir, env) : undefined
}
