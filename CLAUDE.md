# WireBender

- Spec: `docs/superpowers/specs/2026-11-05-wirebender-design.md`. Plan: `docs/superpowers/plans/2026-11-05-wirebender-m1-editor.md`. Read them before changing behaviour.
- Layout: pure TypeScript in `core/` (alias `~core`), CLI in `cli/`, Nitro routes in `server/`, app in `app/`.

## Global constraints (short form)

- `core/` has no UI/Node deps: no Vue, Nuxt, Node `fs`, or DOM. UI and CLI call the same `core/` functions.
- Advisory only: never claim a board is safe to power. Findings end with `Advisory only. Check the board with a meter before powering it.`
- `reference/` is read-only; never import from it.

## Verification

- `pnpm test`
- `pnpm typecheck`
