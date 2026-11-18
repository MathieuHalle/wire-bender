# Backlog

Small things noticed along the way, not yet planned. Newest first. Take an item into a plan
(`docs/superpowers/plans/`) when it is picked up, and remove it here when it is done.

## Next project: stripboard (Veroboard)

*Agreed 2026-11-16, third of three after presets and shapes.* Copper strips joining every hole
of a row, broken where the owner cuts them. It changes how connectivity is built (a strip is
copper the owner did not draw), so it touches the drawing, a "cut" tool, the checks, the bench
sheet (a list of cuts) and 3D. Breadboards could reuse the same idea (fixed strip segments and
rails). Start with a design conversation, as the Move tool did.

## Board shapes follow-ups

*Noted 2026-11-17, from the shapes review (main de046d4).* None of these can change wiring.

- A round board 1 hole wide and an even number long (2 × 1, 4 × 1, …) parses but has no holes
  (every hole centre is half a pitch from the circle's centre). Refuse it in `checkShape`.
- `core/scene3d/board.ts` says the outline's margin keeps "the printed numbers on the board";
  on a round board and beside a notch they print off it (labels stay on the bounding rectangle,
  a design call). Fix the comment.
- The pencil's rubber band (`BoardSide.vue`, the `band` clamp) still stops at `cols`/`rows`, so
  it can preview into a cut corner although the click is refused. Stop it at the last hole the
  board has.
- `{ "kind": "corners", "corners": {} }` is accepted and draws as a rectangle without the
  rounded corners. Normalise it away or refuse it.
- The new Off-the-board findings for trails, wires and leg folds carry no holes, so nothing
  lights on the canvas; lighting the item's other holes would help.

## Board presets follow-ups

*Noted 2026-11-16, from the presets review (v0.2.2).*

- Clearing Columns or Rows in "New board" now shows 1 and would create a 1-wide board, where an
  empty field used to get the server's error. Keep it empty and let the server answer.
- The presets design says the 422 "lists the preset names"; it lists the ids (better for
  scripts). Reword the design.
- `proto-4x6` uses 14 × 20 holes, unconfirmed: the owner counts a board before the next release.
- The MCP `create_board` tool takes only full board data, not a preset or a shape.

## Move tool follow-ups

*Noted 2026-11-16, from the Move follow-ups review (v0.2.1).*

- Labels in a copy drawn past the top or left edge turn with it (sideways at 90° and 270°,
  upside down at 180°).
- The bottom view of a held part fades only when the part has leg folds.
- In the Move tool with nothing held, the hole tooltip and net highlight also snap over the
  diagonal gaps between holes.
- `moveSides` has a guard (`held.side !== 'bottom'`) that never fails: parts are picked on top only.
- Tests: no top-bottom-mirrored `ghostTransform` case, no `moveSides` case with a ghost.

## GitHub Actions still on Node 20

*Noted 2026-11-14, from the v0.1.1 release run.* GitHub runs these actions on Node 24 with a
warning ("Node.js 20 is deprecated … forced to run on Node.js 24"); once Node 20 support is
removed they may stop working. Move each to the newest major that targets Node 24 (check its
releases page and changelog for breaking changes first).

| Action | Used in | Warned |
|---|---|---|
| `docker/build-push-action@v6` | `ci.yml` (image), `release.yml` (image) | yes |
| `docker/setup-buildx-action@v3` | `ci.yml`, `release.yml` (image, merge) | yes |
| `pnpm/action-setup@v4` | `ci.yml` (check) | yes |
| `aws-actions/configure-aws-credentials@v4` | the SaaS repo's `deploy.yml` (not this repo) | yes |
| `docker/login-action@v3`, `docker/metadata-action@v5`, `actions/upload-artifact@v4`, `actions/download-artifact@v4` | `release.yml` | not yet: check while there |

Done when a CI run, a release (`v*.*.*` tag) and a SaaS deploy show no Node 20 annotation.
