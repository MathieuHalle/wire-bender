# WireBender

- Spec: `docs/superpowers/specs/2026-11-05-wirebender-design.md`, and `docs/superpowers/specs/2026-11-06-wirebender-service-design.md` (the service: accounts, live editing, API; it overrides the first where §11 says so). Plans: `docs/superpowers/plans/`. Read them before changing behaviour.
- Layout: pure TypeScript in `core/` (alias `~core`), CLI in `cli/`, Nitro routes in `server/`, app in `app/`.

- Boards: read and write them through the running server's `/api/boards` (see the README); never edit a board file. The file under `data/` is a fixture only.

## Global constraints (short form)

- `core/` has no UI/Node deps: no Vue, Nuxt, Node `fs`, or DOM. UI and CLI call the same `core/` functions.
- Advisory only: never claim a board is safe to power. Findings end with `Advisory only. Check the board with a meter before powering it.`
- `reference/` is read-only; never import from it.

## Verification

- `pnpm test`
- `pnpm typecheck`

## Editing boards through the API

- `:id` in `/api/boards/:id` is a key: a board id (owner only) or a share link id. Roles: owner, edit, view; `PUT` needs edit.
- In public mode a script cannot sign in yet (tokens come in step 3), so API editing is for local mode for now.
- `GET /api/boards/:id` first, then `PUT` with `baseRevision` set to that GET's `head`. Never PUT without it.
- A `409` means someone else changed the board in between (a tablet edit counts): GET it again, redo the change on the new board, and PUT with the new `head`. Never retry the old body.
