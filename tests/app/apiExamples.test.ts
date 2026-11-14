import { describe, expect, it } from 'vitest'
import { curlBoards, mcpAdd, serverOrigin } from '../../app/utils/apiExamples'

describe('Connections tab examples', () => {
  it('takes the origin of the page URL, without path or query', () => {
    expect(serverOrigin(new URL('https://app.wirebender.net/settings/connections#api'))).toBe('https://app.wirebender.net')
    expect(serverOrigin(new URL('http://localhost:3000/settings/connections'))).toBe('http://localhost:3000')
    expect(serverOrigin(new URL('http://192.168.1.20:3001/settings/connections?x=1'))).toBe('http://192.168.1.20:3001')
  })

  it('drops the scheme default port', () => {
    expect(serverOrigin(new URL('https://app.wirebender.net:443/settings/connections'))).toBe('https://app.wirebender.net')
  })

  it('puts the server in the curl example', () => {
    expect(curlBoards('https://app.wirebender.net')).toBe('curl -H "Authorization: Bearer $WIREBENDER_TOKEN" https://app.wirebender.net/api/boards')
  })

  it('points the MCP server at the server', () => {
    expect(mcpAdd('https://app.wirebender.net')).toBe('claude mcp add wirebender --env WIREBENDER_SERVER=https://app.wirebender.net --env WIREBENDER_TOKEN=<your token> -- pnpm --silent --dir <path to wire-bender> wirebender mcp')
  })
})
