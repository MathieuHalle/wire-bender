# WireBender

- Spec and plan: `docs/` (design spec and the M1 implementation plan). Read them before changing behaviour.
- Layout: pure TypeScript in `core/` (alias `~core`), CLI in `cli/`, Nitro routes in `server/`, app in `app/`.

## Global constraints (short form)

- `core/` has no UI/Node deps: no Vue, Nuxt, Node `fs`, or DOM. UI and CLI call the same `core/` functions.
- Advisory only: never claim a board is safe to power. Findings end with `Advisory only. Check the board with a meter before powering it.`
- `reference/` is read-only; never import from it.

## Verification

- `pnpm test`
- `pnpm typecheck`
