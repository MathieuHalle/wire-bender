// A small client for the WireBender API, shared by the CLI and the MCP server.
// The token is sent as a Bearer header and is never printed or put in an error.
export type ApiConfig = { url: string, token?: string }

export const DEFAULT_URL = 'http://localhost:3000'

/** Value of `--name <v>` or `--name=<v>` in argv, if given. */
function flagValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === name) return argv[i + 1]
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1)
  }
  return undefined
}

/** `--url` / `--token` beat `WIREBENDER_SERVER` / `WIREBENDER_TOKEN`, which beat the default URL. */
export function configFrom(argv: string[], env: Record<string, string | undefined>): ApiConfig {
  const url = flagValue(argv, '--url') || env.WIREBENDER_SERVER || DEFAULT_URL
  const token = flagValue(argv, '--token') || env.WIREBENDER_TOKEN || undefined
  return { url: url.replace(/\/+$/, ''), token }
}

export async function apiCall(cfg: ApiConfig, method: string, path: string, body?: unknown): Promise<{ status: number, json: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`
  let res: Response
  try {
    res = await fetch(`${cfg.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (e) {
    // The reason comes from the network stack; it never holds the request headers.
    const reason = e instanceof Error ? e.message : String(e)
    return { status: 0, json: { error: `Cannot reach ${cfg.url}: ${reason}`.replaceAll(cfg.token ?? '\0', '***') } }
  }
  const text = await res.text()
  let json: unknown = null
  if (text !== '') {
    try {
      json = JSON.parse(text)
    } catch {
      json = { error: text }
    }
  }
  return { status: res.status, json }
}

/** The server's refusal as lines to print, verbatim: `{ error }` or `{ errors: [...] }`. */
export function errorLines(status: number, json: unknown): string[] {
  const j = (json ?? {}) as { error?: unknown, errors?: unknown, statusMessage?: unknown, message?: unknown }
  if (Array.isArray(j.errors)) return j.errors.map(String)
  for (const v of [j.error, j.message, j.statusMessage]) if (typeof v === 'string' && v !== '') return [v]
  return [`HTTP ${status}`]
}
