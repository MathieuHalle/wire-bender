// The session cookie (and nuxt-auth-utils' OAuth state, PKCE and nonce cookies) is Secure
// exactly when the app is reached over https. h3 makes session cookies Secure by default,
// and nuxt-auth-utils makes its OAuth cookies Secure in a production build; Safari drops a
// Secure cookie over http://localhost (Chrome keeps it), so signing in looped back.
//
// - Public mode: Secure when WIREBENDER_URL is https.
// - Local mode: Secure when the request came over TLS on this server's own socket (a header
//   never decides it); a local server is usually plain http, often a tablet on a LAN address.
// - NUXT_SESSION_COOKIE_SECURE, when set, wins.
//
// Runtime config is frozen when the server loads, and nuxt-auth-utils' own routes (sign-out,
// the OAuth round-trip) read it, not a per-call option. So the rule is applied where every
// response passes, `nuxt dev` and a production build alike: the access middleware wraps the
// response's Set-Cookie writes for these cookies (`enforceCookieSecure`).
// Cookies must never be sent with `res.writeHead(status, headers)`: that bypasses the wrap.
import type { Mode } from './mode'

export type CookieRuleEnv = Record<string, string | undefined>

/** Whether the session and OAuth cookies are Secure for a request; `encrypted` is its own socket's TLS. */
export function cookieSecure(mode: Mode, env: CookieRuleEnv, encrypted: boolean): boolean {
  const forced = env.NUXT_SESSION_COOKIE_SECURE?.trim().toLowerCase()
  if (forced !== undefined && forced !== '') return !(forced === 'false' || forced === '0')
  if (mode === 'public') return (env.WIREBENDER_URL ?? '').toLowerCase().startsWith('https://')
  return encrypted
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * At start: the warning to log when public mode serves an http:// WIREBENDER_URL on a host
 * other than this machine's loopback, so the session cookie goes out without Secure. Null
 * when there is nothing to warn about.
 */
export function insecureCookieWarning(mode: Mode, env: CookieRuleEnv): string | null {
  if (mode !== 'public' || cookieSecure(mode, env, false)) return null
  let url: URL
  try {
    url = new URL(env.WIREBENDER_URL ?? '')
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null
  return `[wirebender] WIREBENDER_URL is http:// on ${url.hostname}: the session cookie will not be Secure, so anyone on the network path can read it. Use https.`
}

/** The cookies the rule covers: the session (by its name) and nuxt-auth-utils' `nuxt-auth-*` ones. */
const covered = (name: string, sessionName: string): boolean => name === sessionName || name.startsWith('nuxt-auth-')

/**
 * One Set-Cookie value with the Secure attribute as the rule says: added, or removed. A
 * SameSite=None cookie keeps Secure (browsers refuse it without), and cookies the rule does
 * not cover are left as they are.
 */
export function withSecure(cookie: string, secure: boolean, sessionName: string): string {
  const parts = cookie.split(';')
  const name = parts[0]!.split('=')[0]!.trim()
  if (!covered(name, sessionName)) return cookie
  const attrs = parts.slice(1).map(a => a.trim()).filter(a => a !== '')
  const sameSiteNone = attrs.some(a => /^samesite\s*=\s*none$/i.test(a))
  const kept = attrs.filter(a => a.toLowerCase() !== 'secure')
  if (secure || sameSiteNone) kept.push('Secure')
  return [parts[0]!.trim(), ...kept].join('; ')
}

type HeaderValue = number | string | readonly string[]
/** The parts of a Node response whose Set-Cookie writes are wrapped. */
export interface CookieRes {
  setHeader(name: string, value: HeaderValue): unknown
  appendHeader?(name: string, value: string | readonly string[]): unknown
}

const WRAPPED = Symbol('wirebender.cookieSecure')

function mapCookies(value: HeaderValue, secure: boolean, sessionName: string): HeaderValue {
  if (typeof value === 'number') return value
  return typeof value === 'string' ? withSecure(value, secure, sessionName) : value.map(v => withSecure(v, secure, sessionName))
}

/** Every Set-Cookie this response writes from now on follows the rule (once per response). */
export function enforceCookieSecure(res: CookieRes, secure: boolean, sessionName: string): void {
  const marked = res as CookieRes & { [WRAPPED]?: true }
  if (marked[WRAPPED]) return
  marked[WRAPPED] = true
  const set = res.setHeader.bind(res)
  res.setHeader = (name, value) => set(name, name.toLowerCase() === 'set-cookie' ? mapCookies(value, secure, sessionName) : value)
  if (res.appendHeader) {
    const append = res.appendHeader.bind(res)
    res.appendHeader = (name, value) => append(name, name.toLowerCase() === 'set-cookie' ? mapCookies(value, secure, sessionName) as string | readonly string[] : value)
  }
}
