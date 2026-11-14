// The example commands on the Connections tab, for the server the page was opened on.

/** `https://app.example.org`, from the page's own URL: no path, no trailing slash. */
export function serverOrigin(url: URL): string {
  return url.origin
}

/** The token example: list your boards. */
export function curlBoards(origin: string): string {
  return `curl -H "Authorization: Bearer $WIREBENDER_TOKEN" ${origin}/api/boards`
}

/** Adds the MCP server to Claude Code, pointed at this server. */
export function mcpAdd(origin: string): string {
  return `claude mcp add wirebender --env WIREBENDER_SERVER=${origin} --env WIREBENDER_TOKEN=<your token> -- pnpm --silent --dir <path to wire-bender> wirebender mcp`
}
