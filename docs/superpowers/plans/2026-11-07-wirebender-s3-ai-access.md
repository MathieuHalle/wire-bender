# WireBender Step 3: AI Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude (or any script) works on a board through the API with a personal token. This includes an MCP server for Claude Code and CLI `import`/`pull`, and every change is live and recorded like an editor change.

**Architecture:** Tokens are rows owned by an account, sent as `Authorization: Bearer wb_…`.
- `whoIs` resolves a valid token to its user, with a `token` field. So every existing access rule applies unchanged, and a short deny-list covers what a token may never do.
- A thin HTTP client in `cli/client.ts` is shared by the new CLI commands and by the MCP server (`cli/mcp.ts`, stdio). The server is the only place rules live.

**Tech Stack:** Nuxt 4 / Nitro, drizzle + better-sqlite3, nuxt-auth-utils 0.6.2, Yjs rooms (step 1), `@modelcontextprotocol/sdk` (new, stdio transport), zod (already a dependency), tsx for the CLI.

**Spec:** `docs/superpowers/specs/2026-11-06-wirebender-service-design.md` (§9 API, tokens and MCP; §6 presence; §7 revisions; §12 step 3). Step 2's plan and rulings (R1–R14, in the step 2 ledger, summarised in the README) still hold.

## Global Constraints

- **Token format:**
  - the token is `wb_` followed by 43 characters of base64url (32 random bytes);
  - it is shown once, at creation, and never again;
  - only its sha256 is stored, plus a display prefix: the first 8 characters after `wb_`.
- **Tokens are sent only in `Authorization: Bearer <token>`.**
  - They are never accepted from a query string, a cookie or a body.
  - They are never logged, and never echoed back after creation.
- **A token acts as its user** (spec §9), and is refused with 403 `{ error: 'Not allowed with a token.' }` on these routes:
  - `DELETE /api/me` and `POST /api/me/restore`;
  - `DELETE /api/boards/:id` (delete for good);
  - `PATCH /api/boards/:id/sharing` and `POST /api/boards/:id/sharing/regenerate`;
  - every `/api/tokens` route;
  - every `/api/admin/*` route;
  - `POST /api/setup`.

  Trash and untrash are allowed. Fork, duplicate, import, PUT, undo, redo and restore are allowed.
- **A wrong, revoked or malformed token** gives 401 `{ error: 'Invalid token.' }`. A request carrying a bearer token never falls back to the cookie session.
- **When the user stops being active, their tokens stop working too.** A suspended, deleted or purged user's tokens give 401 `Invalid token.`. Purge deletes the user's tokens.
- **Names and limits:**
  - token names are 1–60 code points, cleaned like display names (`server/utils/accounts.ts` name helper);
  - at most 20 tokens per account; the 21st gives 409 `{ error: 'Token limit reached (20). Revoke one first.' }`.
- **`last_used_at`** is updated at most once per 60 s per token.
- **Revisions made with a token:**
  - `author` is `<token name> · <user name>` (like `Local · This computer`);
  - `author_id` is the user, and a new `token_id` column holds the token's id;
  - an undo of such a revision reads "undo of #N by <token name>" wherever step 1 builds undo summaries.
- **Local mode:**
  - loopback and paired devices still need no token;
  - tokens still work, created and owned by the local user `local`;
  - a token's author is `<token name> · Local`.
- **Presence:** an API write made with a token shows on the board for everyone, as the token's name, for 30 s after its last write (spec §6). It is a server-made presence entry, never a client's.
- **Migrations only add** (the step 2 rule; R2's rebuild was the one exception).
- **CLI/MCP configuration:**
  - `--url` or env `WIREBENDER_SERVER`, default `http://localhost:3000`;
  - `--token` or env `WIREBENDER_TOKEN`, optional.

  `WIREBENDER_URL` stays the server's own public address and is not read by the CLI.
- **MCP `replace_board` always sends `baseRevision`**, which is a required tool argument. On 409 it returns `The board changed since revision <n>; read it again (head is <head>) and redo your change.`
- **Advisory text is unchanged.** The MCP `check_board` result and CLI output end with `Advisory only. Check the board with a meter before powering it.`
- **Never commit a token**, even a test one; tests mint their own.

## Review Focus

1. **A token leaking into logs, URLs or the history.** A reasonable person expects the token string to appear nowhere after the creation dialog. Task 2 test: run a full authenticated PUT, then assert that no response body, revision row or presence state contains the token string.
2. **A revoked token mid-session (the MCP server keeps running).** The next call must give 401 at once, with no cache. Task 2 test: revoke, then the next GET gives 401.
3. **Bearer and cookie both present.** A token holder must not get the cookie user's extra rights, and a bad token must not silently use the cookie. Task 2 test: a request with a valid cookie session plus an invalid bearer gives 401. A request with a valid token plus another user's cookie acts as the token's user.
4. **Claude replaces a board from a stale read.** The board must not be overwritten. Task 6 test: `replace_board` with an old `baseRevision` returns the exact 409 message, and the board is unchanged.
5. **A huge or invalid board through MCP or `import`.** The server's 413 or 422 message must reach the caller in full, so Claude can fix it. Task 5 and Task 6 tests: the 422 `errors` list and the 413 text are passed through verbatim.

---

## File Structure

- `server/db/schema.ts`: adds the `tokens` table and `revisions.token_id`; migration `0003_*`.
- `server/utils/tokens.ts`: mint, hash, find by bearer, list, revoke, touch `last_used`. This is the only file that knows the token format.
- `server/api/tokens/index.get.ts`, `index.post.ts`, `[id].delete.ts`: owner-only token management. Refused with a token.
- `server/utils/who.ts`: gains a bearer path. `Who` (kind `user` or `local`) gains `token?: { id: string, name: string }`.
- `server/utils/access.ts` and `server/middleware/access.ts`: the gate accepts a valid bearer as signed in, and the token deny-list lives here, in one place.
- `server/utils/api.ts` and `server/utils/rooms.ts`: author/`token_id` on writes, and the token presence entry.
- `app/pages/account.vue` and `app/components/TokensPanel.vue`: create, list and revoke tokens. Also shown in local mode.
- `app/pages/api.vue`: the API page the spec asks for (routes, auth, errors), linked from the account page.
- `cli/client.ts`: `apiCall(cfg, method, path, body?)`, used by the CLI and MCP.
- `cli/wirebender.ts`: adds `import`, `pull` and `mcp`.
- `cli/mcp.ts`: the MCP server's tools.
- Docs: `README.md` and `CLAUDE.md` (use the MCP server).

---

### Task 1: Tokens table and management routes

**Files:**
- Create: `server/utils/tokens.ts`, `server/api/tokens/index.get.ts`, `server/api/tokens/index.post.ts`, `server/api/tokens/[id].delete.ts`
- Modify: `server/db/schema.ts`, `server/utils/lifecycle.ts` (purge deletes tokens)
- Generate: a migration with `pnpm db:generate` (additive)
- Test: `tests/server/tokens.test.ts`

**Interfaces:**
- Produces:
  - **Table `tokens`:** `id` text pk (uuid), `user_id` text not null, `name` text not null, `hash` text not null unique (hex sha256), `prefix` text not null, `created_at` integer, `last_used_at` integer nullable. Also adds the `revisions.token_id` column, text, nullable.
  - `mintToken(db, userId, name): { ok: true, token: string, row: TokenRow } | { ok: false, status: 409 | 422, body }`
  - `tokenByBearer(db, bearer: string): TokenRow | null` checks the format first and uses a constant-time-safe lookup by hash.
  - `listTokens(db, userId): { id, name, prefix, createdAt, lastUsedAt }[]`, newest first.
  - `revokeToken(db, userId, id): boolean` deletes the row, and only the user's own.
  - `touchToken(db, row, now)` writes `last_used_at` when it is older than 60 s.
  - **Routes:**
    - `GET /api/tokens` returns the list;
    - `POST /api/tokens {name}` returns `201 { id, name, prefix, token }`;
    - `DELETE /api/tokens/:id` returns `204`, or 404 when it isn't yours.

    They are signed-in only (the local user in local mode) and anonymous callers get 401. The token-holder refusal is added in Task 2.
- [ ] **Step 1: Failing tests:**
  - `a minted token matches wb_ + 43 base64url chars and is stored only as its hash`: no column holds the token.
  - `the 21st token is refused with the limit message`
  - `names are cleaned and 1–60 code points`
  - `revoke deletes only your own token`
  - `purge removes a purged user's tokens`
  - `last_used_at moves at most once a minute`
- [ ] **Step 2:** Run `pnpm vitest run tests/server/tokens.test.ts` and confirm it fails because the module is missing.
- [ ] **Step 3:** Implement, with `randomBytes(32).toString('base64url')`. Reuse the name helper from `accounts.ts`.
- [ ] **Step 4:** Run the tests until they pass. `pnpm test`, `pnpm typecheck` and `pnpm lint` must be clean.
- [ ] **Step 5:** Commit `feat(tokens): personal API tokens, stored hashed`.

### Task 2: Requests made with a token

**Files:**
- Modify: `server/utils/who.ts`, `server/utils/access.ts`, `server/middleware/access.ts`, `server/utils/api.ts`, `server/utils/rooms.ts`, and the deny-listed routes only if the deny-list can't live in the middleware.
- Test: `tests/server/tokenAuth.test.ts`, `tests/server/middleware.test.ts`

**Interfaces:**
- Consumes:
  - `tokenByBearer` and `touchToken` (Task 1);
  - `resolveSession` and `whoIs` (step 2);
  - `withAccess` and `withOwner` (step 2).
- Produces:
  - `Who` for `user` and `local` gains `token?: { id: string, name: string }`;
  - `authorOf(who)` returns `<token name> · <user name>` when `who.token` is set;
  - `WriteMeta` gains `tokenId?: string`, stored in `revisions.token_id`;
  - `tokenRefusal(path, method): boolean` is the deny-list from Global Constraints, checked once in the middleware.
- **The bearer path:**
  - An `Authorization` header that starts with `Bearer ` is decided here, and the cookie is never read.
  - A valid token of an active user gives that user, plus `token`.
  - Anything else gives 401 `Invalid token.`.
  - In local mode, a valid token gives `{ kind: 'local', … , token }`.
  - Bearer requests are not CSRF-sensitive, so the Origin check stays as it is for cookie requests and is skipped for bearer requests without an Origin header.
- [ ] **Step 1: Failing tests:**
  - `a token reads and writes the user's boards like the user`
  - `a token is refused on each deny-listed route with Not allowed with a token.`: one case per route in Global Constraints.
  - `trash and untrash work with a token`
  - `a revoked token is 401 on the next call` (Review Focus 2)
  - `a suspended user's token is 401`
  - `an invalid bearer never falls back to the cookie` (Review Focus 3)
  - `a token's revision has author "<token> · <user>", author_id and token_id`
  - `undo of a token revision is summarised "undo of #N by <token>"`
  - `the token string appears in no response, revision or presence state` (Review Focus 1)
  - `a token in ?token= is ignored`: the request is treated as anonymous.
  - `local mode: a valid token from a non-loopback address is local, and author "<token> · Local"`
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. Make one bearer check in `resolveSession`, so every route and the socket upgrade get it for free. Sockets with a token aren't needed by any client, but must not crash: an upgrade with a bearer header is authenticated the same way.
- [ ] **Step 4:** Run the tests until they pass, and run the full suite clean.
- [ ] **Step 5:** Commit `feat(tokens): requests made with a token act as its user, with limits`.

### Task 3: The token shows on the board

**Files:**
- Modify: `server/utils/rooms.ts`, `server/utils/api.ts` (the write paths call it)
- Test: `tests/server/rooms.test.ts`

**Interfaces:**
- Produces: `Room.tokenActive(token: { id, name })`. It sets or renews a server-owned awareness entry `{ user: { name: <token name>, kind: 'token' } }` under a client id reserved for that token. Every peer and each new joiner receives it. It is removed 30 s after the last call, and at once when the room closes. Peers can't claim the reserved id: step 2's "never another peer's id" rule already refuses this, and the reserved ids are added to that check.
- [ ] **Step 1: Failing tests:**
  - `an API write with a token shows the token's name to peers`
  - `the entry goes 30 s after the last write` (fake timers)
  - `a new joiner sees an active token entry`
  - `a peer cannot claim a token's presence id`
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement. The client already renders `user.name`. Show `kind: 'token'` with a robot icon in the presence list (`app/composables/useLiveBoard.ts` and the presence component), with no avatar.
- [ ] **Step 4:** Run the tests until they pass, and run the full suite clean.
- [ ] **Step 5:** Commit `feat(live): an AI token shows on the board while it works`.

### Task 4: Tokens page and API page

**Files:**
- Create: `app/components/TokensPanel.vue`, `app/pages/api.vue`
- Modify: `app/pages/account.vue` (Tokens section; also in local mode, where the page currently says there is nothing to sign in to)
- Test: none at component level (the repo has no component setup). The routes are covered by Task 1.

**Interfaces:**
- Consumes: the Task 1 routes.
- **TokensPanel:**
  - a name field and **Create**;
  - the new token is shown once, in a read-only field with **Copy**, plus the line `This token is shown only now. Store it somewhere safe.`;
  - a list of name, `wb_<prefix>…`, created, and last used ("never");
  - **Revoke**, with an in-page confirm;
  - errors show the server's `error`.
- **`/api` page:** static content explaining:
  - auth (Bearer, where to create a token, what a token can't do);
  - the route table, the same as the README's;
  - error shapes (`{error}`, `{errors:[…]}`, 409 with `head`);
  - the GET → PUT with `baseRevision` rule;
  - how to run the MCP server (Task 6).

  Link it from the account page.
- [ ] **Step 1:** Build both. Run `pnpm typecheck` and `pnpm lint` until clean.
- [ ] **Step 2:** Browser look on a scratch server (local mode):
  - create a token, copy it, and see it listed with its prefix;
  - use it with `curl -H "Authorization: Bearer …" /api/boards` and see "last used" change;
  - revoke it, and the curl gives 401.
- [ ] **Step 3:** Commit `feat(app): tokens in the account page; an API page`.

### Task 5: API client and CLI `import` / `pull`

**Files:**
- Create: `cli/client.ts`
- Modify: `cli/wirebender.ts`, `package.json` (no new dependency)
- Test: `tests/cli/client.test.ts`, `tests/cli/importPull.test.ts`. They use a fake `fetch`; one test drives the real Nitro handlers through the existing server test harness, if one exists.

**Interfaces:**
- Produces:
  - `type ApiConfig = { url: string, token?: string }`
  - `configFrom(argv: string[], env): ApiConfig` reads `--url` and `--token`, then `WIREBENDER_SERVER` and `WIREBENDER_TOKEN`, and defaults the URL to `http://localhost:3000`.
  - `apiCall(cfg, method, path, body?): Promise<{ status: number, json: unknown }>`. It sends `Authorization` only when a token is set, and never prints the token. A network failure gives `{ status: 0, json: { error: 'Cannot reach <url>: <reason>' } }`.
  - **CLI commands:**
    - `wirebender import <file> [--url] [--token]` validates the board locally first (`parseBoard`, so the same errors show without a round trip), then calls `POST /api/boards {board}`. It prints `imported <name> → <url>/b/<id>`. Exit codes: 0, 1 when the server refused (its message printed verbatim), 2 when the file is invalid.
    - `wirebender pull <board> -o <file> [--url] [--token]` takes a board id or link id. It writes the board as pretty JSON (2-space indent plus a trailing newline, the same as the download route). It never overwrites a file without `--force`; without it, it exits 2 with `<file> exists; add --force to overwrite`.
  - `USAGE` lists the new commands.
- [ ] **Step 1: Failing tests:**
  - `configFrom: flags beat env, env beats the default`
  - `apiCall sends Bearer only with a token and never includes it in errors`
  - `import prints the board link and exits 0`
  - `import of an invalid file exits 2 without calling the server`
  - `import passes the server's 413 or 422 message through verbatim` (Review Focus 5)
  - `pull writes the board JSON`
  - `pull refuses to overwrite without --force`
  - `a network failure says Cannot reach <url>`
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement with the global `fetch` (Node ≥ 18).
- [ ] **Step 4:** Run the tests until they pass, and run the full suite clean.
- [ ] **Step 5:** Commit `feat(cli): import and pull against a server`.

### Task 6: The MCP server

**Files:**
- Create: `cli/mcp.ts`
- Modify: `cli/wirebender.ts` (the `mcp` command), `package.json` (add `@modelcontextprotocol/sdk`, latest 1.x)
- Test: `tests/cli/mcp.test.ts`. It uses the SDK's in-memory transport, or calls the tool handlers directly, with a fake `apiCall`.

**Interfaces:**
- Consumes: `apiCall` and `configFrom` (Task 5).
- Produces: `wirebender mcp [--url] [--token]` runs an MCP server on stdio, named `wirebender`. Tool inputs are zod schemas, and every result is JSON text:

  | Tool | Calls |
  |---|---|
  | `list_boards { list?: 'mine'\|'shared'\|'trash' }` | `GET /api/boards?list=` |
  | `get_board { board }` | `GET /api/boards/:board`, returns `{ id, name, head, role, board }` |
  | `replace_board { board, baseRevision, data }` | `PUT /api/boards/:board { baseRevision, board: data }`; `baseRevision` required |
  | `check_board { board }` | `GET /api/boards/:board/check`, plus the advisory line |
  | `list_revisions { board }` | `GET …/revisions` |
  | `get_revision { board, n }` | `GET …/revisions/:n` |
  | `undo { board }` / `redo { board }` | `POST …/undo` / `…/redo` |
  | `restore_revision { board, n }` | `POST …/revisions/:n/restore` |
  | `create_board { data }` | `POST /api/boards { board: data }` |

  - **Errors:** an error status becomes an MCP tool error with the server's text verbatim. A 409 on `replace_board` becomes the exact Global Constraints message, with the head from the response or a fresh GET.
  - **Logging:** nothing is written to stdout except the protocol. Logs go to stderr, never including the token.
- [ ] **Step 1: Failing tests:**
  - `tools are listed with these names`
  - `replace_board requires baseRevision`: schema validation.
  - `a 409 gives the "read it again" message and changes nothing` (Review Focus 4)
  - `check_board ends with the advisory line`
  - `server error messages pass through verbatim` (Review Focus 5)
  - `stdout carries only protocol frames`: start the command, send `initialize` and `tools/list`, and parse every stdout line as JSON-RPC.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement with `McpServer` and `StdioServerTransport` from the SDK.
- [ ] **Step 4:** Run the tests until they pass, and run the full suite clean.
- [ ] **Step 5:** Commit `feat(mcp): a WireBender MCP server for Claude Code`.

### Task 7: Docs and the end-to-end check

**Files:** Modify `README.md` and `CLAUDE.md`.
- **README:**
  - a Tokens section (create, revoke, what a token can't do, how history shows token changes);
  - CLI `import` and `pull`;
  - MCP setup for Claude Code: `claude mcp add wirebender -- pnpm --dir <repo> wirebender mcp --url http://localhost:3000`, plus `--token` or `WIREBENDER_TOKEN` for a public server;
  - the `/api` page.
- **CLAUDE.md:** "Boards: use the `wirebender` MCP server tools (`get_board`, then `replace_board` with `baseRevision`). The HTTP API rules below still apply."
- [ ] **Step 1:** Write the docs from the code. Grep every name.
- [ ] **Step 2, end-to-end on a scratch local server (port 3003):**
  - register the MCP server with Claude Code, pointing at the scratch server;
  - from a Claude Code session, list boards, read channel board 2, make a small change with `replace_board`, and run `check_board`;
  - in the browser, the change appears live, presence shows the token's name for about 30 s, and history shows `<token> · Local`;
  - Undo in the browser reverts it, with the summary "undo of #N by <token>";
  - then the same against a scratch public server with a minted token: a deny-listed call (sharing PATCH) gives 403.
- [ ] **Step 3:** Commit `docs: tokens, MCP server, CLI import and pull`.

## After this plan

Step 3 is done when Claude Code, through the MCP server, changes a board that the owner is watching in the editor, and the owner undoes it from the editor (spec §1). Next is step 4: Docker, backups, bundles and the format docs.
