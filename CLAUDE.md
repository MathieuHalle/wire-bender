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
