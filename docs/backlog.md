# Backlog

Small things noticed along the way, not yet planned. Newest first. Take an item into a plan
(`docs/superpowers/plans/`) when it is picked up, and remove it here when it is done.

## Next project: stripboard and breadboard

*Agreed 2026-11-16 (stripboard), third of three after presets and shapes. Paused 2026-11-19, then
widened to breadboards and picked up the same day (owner).* Both boards have copper the owner did
not draw: holes joined before anything is placed. Three steps:

1. **The shared layer:** built-in strips in the board file, worked into connectivity, the checks,
   the drawing and 3D.
2. **Breadboard:** fixed layouts (full, half, mini; the centre gap; power rails, split on some)
   as presets. Nothing is cut or soldered: parts plug in and wires are jumpers, so trails and leg
   folds don't apply, and the bench sheet lists where each part goes.
3. **Stripboard (Veroboard):** strips along every row, a "cut" tool, cuts in the file, checks on
   cuts, and a list of cuts on the bench sheet.

Start with a design conversation, as the Move tool did.

## Board presets follow-ups

*Noted 2026-11-16, from the presets review (v0.2.2). The rest were done 2026-11-19.*

- `proto-4x6` uses 14 × 20 holes, unconfirmed: the owner counts a board before the next release.

## GitHub Actions still on Node 20

*Noted 2026-11-14, from the v0.1.1 release run.* This repo's workflows moved on 2026-11-19
(build-push v7, setup-buildx v4, login v4, metadata v6, upload-artifact v7, download-artifact v8;
`pnpm/action-setup` v5, not v6, which bootstraps through pnpm 11 while this repo is on pnpm 9).
The SaaS repo's `deploy.yml` moved to `configure-aws-credentials@v6`; CI (d44d3e4) and a SaaS
deploy (abf79aa) ran with no Node 20 annotation. Left: done when a release (`v*.*.*` tag) shows
none either (it is the only run that uses login, metadata, upload- and download-artifact).
