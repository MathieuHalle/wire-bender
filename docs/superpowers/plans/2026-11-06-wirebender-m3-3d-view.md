# WireBender milestone 3 (3D view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 3D view of the board for the final review. It shows:
- the board slab with holes and pads;
- real-size simple part bodies with legs;
- bare trails, insulated wires (laid, flying, mixed), solder joints, leg folds and solder bridges.

You can orbit the board, see it from the top or from below, and hover to see a part or net. Every edit updates the view.

**Architecture:**
- A pure scene builder, `core/scene3d/`, turns a `BoardFile` into a flat list of primitives with ids and tags: boxes, cylinders, tubes and solder cones, in board millimetres. It is data only and unit-tested, with no three.js. This is the 3D counterpart of `core/bench/`.
- A client-only renderer, `app/components/Board3D.vue`, maps the primitives to three.js meshes through TresJS.
- The editor gets a `3D` view next to `Both sides / Top / Bottom`. The 3D code is loaded lazily, so the 2D editor does not get heavier.

**Tech Stack:** three.js through TresJS (`@tresjs/core` and `@tresjs/cientos` for OrbitControls), on the existing Nuxt 4 / Vue 3.5 / Vitest setup.

**Spec:** `docs/superpowers/specs/2026-11-05-wirebender-design.md`:
- §5, the "3D view" bullet: real-size simple bodies (boxes, cylinders, legs, pins), the board, trails and wires, both sides. Perfwire's 3D view is the quality bar; better connector and header models are a nice-to-have.
- §9: three.js via TresJS.
- §11, build-order step 3.

## Global Constraints

- All M1 and M2 Global Constraints still apply:
  - `core/` has no Vue, Nuxt, fs or DOM imports, and no `three`;
  - the UI is in English;
  - hole names look like `G13`;
  - commit trailers are `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01J81HjMZYUjAKfCSSaUaXzJ`.
- `three` and TresJS are imported only under `app/`, and only from the lazily loaded 3D component and its helpers. The 2D page must not pull three.js into its initial bundle.
- **Scene coordinates, in mm:**
  - x = (col − 1) × pitch, so it grows to the right seen from the top;
  - z = (row − 1) × pitch, so row A is at z = 0 and z grows toward the viewer seen from the top;
  - y is up;
  - the board's top surface is y = 0 and its bottom surface is y = −`BOARD_THICKNESS_MM` (1.6).
  - Use the board's `pitchMm` for holes and conductors, and `FOOTPRINT_PITCH_MM` wherever `placePart` geometry is used. These are the same values `core/` already uses.
- **Physical sizes (constants in `core/scene3d/dims.ts`):**
  - board thickness 1.6;
  - hole diameter 1.0;
  - pad diameter 1.8, copper thickness 0.05;
  - bare wire diameter 0.6;
  - insulated wire outside diameter 1.4;
  - leg diameter 0.6;
  - legs stick out 1.5 below the bottom surface;
  - solder cone base diameter 1.8, height 0.9;
  - board margin past the outer holes = half a pitch, the same outline the 2D view draws.
- **Read-only:** the 3D view never changes the board file. It has no edit tools.
- **No network at runtime:** no HDR or environment maps, fonts, textures or models are fetched from a URL. cientos `Environment` presets download files, so they are forbidden. Use plain lights.
- The 2D view stays the default and keeps working when WebGL is unavailable.
- Colours: trails and bare copper `#b87333`; insulated wires use `wire.color`, or the net colour, or `#1f6fb2`, the same fallback as the bench sheet. The board is perfboard brown-green (builder's call), and pads are tinned copper.

## Review Focus

1. **The bottom view matches the mirrored 2D bottom view.** In the 2D view, with "mirror bottom" on, A1 is at the top-right. The `Bottom` camera preset must show the same picture, as if the board was turned over in the hand. → Task 3 test `bottom preset matches the mirrored 2D view`, which projects A1 and A{cols} with the preset camera.
2. **Live updates, camera and memory.** An edit, or a file reload from Claude, rebuilds the meshes. It must keep the camera where it was and leave no geometries or materials behind. → Task 3 step: browser check that `renderer.info.memory.geometries` stays flat over 10 rebuilds, and the camera position is unchanged after an edit.
3. **One-sided boards.** They have no top pads, and no solder cones on the top. A top-side bare run on a one-sided board sits on the top surface, and its ends go down through their holes to solder on the bottom. → Task 1 test `one-sided board has no top pads`; Task 2 test `top trail on a one-sided board is soldered underneath`.
4. **Odd boards don't crash the view.** This covers:
   - an unknown footprint (`placePart` throws): skip it and report it in `scene.skipped`;
   - a 1-point or zero-length trail;
   - a flying wire with both ends in the same hole;
   - a part overhanging the board edge;
   - an empty board.

   → Task 1 test `unknown footprint is skipped and reported`; Task 2 tests for degenerate conductors.
5. **WebGL unavailable or the 3D chunk fails to load.** The 3D panel shows a short message ("3D view needs WebGL…") and the rest of the editor keeps working. → Task 3 step: a test of the `webglAvailable()` guard path, and a browser check with WebGL forced off (`--disable-webgl` / a stubbed `getContext`).

---

## File Structure

```
core/scene3d/dims.ts         physical constants (mm)
core/scene3d/types.ts        Prim, Tag, Scene3D
core/scene3d/board.ts        board slab, hole list, pads per side
core/scene3d/parts.ts        part bodies + legs + leg solder cones (per footprint shape)
core/scene3d/conductors.ts   trails, wires (laid/flying/mixed), joints, leg folds, solder bridges
core/scene3d/index.ts        buildScene(board): Scene3D (composes the above)
app/utils/scene3dThree.ts    Prim -> three.js geometry/material (client only), dispose helpers
app/utils/cameraPresets.ts   preset camera poses (top, bottom, iso) from scene bounds
app/components/Board3D.vue   TresCanvas, OrbitControls, meshes, hover pick, presets
app/components/Toolbar.vue   + "3D" view button
app/pages/index.vue          view '3d' renders <LazyBoard3D> (client only)
tests/core/scene3d-*.test.ts, tests/app/cameraPresets.test.ts
```

---

### Task 1: Scene model, board and parts

**Files:**
- Create: `core/scene3d/dims.ts`, `core/scene3d/types.ts`, `core/scene3d/board.ts`, `core/scene3d/parts.ts` and `core/scene3d/index.ts`. Export `buildScene` from `core/index.ts`.
- Test: `tests/core/scene3d-board.test.ts`, `tests/core/scene3d-parts.test.ts`.

**Interfaces:**
- Consumes: `placePart`, `bodyHeightMm` and `FOOTPRINTS` from `core/footprints.ts`; `holeMm` and `parseHole` from `core/holes.ts`.
- Produces:
  ```ts
  type V3 = [number, number, number]
  interface Tag { kind: 'board' | 'part' | 'leg' | 'trail' | 'wire' | 'joint' | 'fold' | 'bridge', id: string, net?: string | null, label?: string }
  type Prim =
    | { kind: 'box', center: V3, size: V3, rotY?: number, color: string, tag: Tag }        // size = [x, y, z] extents
    | { kind: 'cylinder', a: V3, b: V3, radius: number, color: string, tag: Tag }         // axis a→b
    | { kind: 'tube', points: V3[], radius: number, color: string, tag: Tag }             // polyline, sharp corners allowed
    | { kind: 'cone', base: V3, up: 1 | -1, radius: number, height: number, color: string, tag: Tag } // solder
  interface Scene3D {
    board: { widthMm: number, depthMm: number, thicknessMm: number, center: V3 }
    holes: { x: number, z: number }[]
    pads: { top: { x: number, z: number }[], bottom: { x: number, z: number }[] }
    prims: Prim[]
    bounds: { min: V3, max: V3 }
    skipped: string[]     // human-readable: "part X1: unknown footprint foo"
  }
  buildScene(board: BoardFile): Scene3D
  ```
  `holes` and `pads` are lists, not prims, so the renderer can instance them. A tag `id` is a part ref, `<ref>.<pin>` for legs, or a trail or wire id. `net` is the net of that conductor or leg, or null for NC.

- [ ] **Step 1: Write the failing tests.**
  - `board slab matches the 2D outline`: on board 2 (`tests/fixtures/channel-board-2.json`), `widthMm = (cols − 1) × pitch + pitch` and `depthMm = (rows − 1) × pitch + pitch`. The slab centre is at y = −0.8, and `holes.length === cols × rows`.
  - `two-sided board has pads on both sides`: `pads.top.length === pads.bottom.length === holes.length`, with blocked holes still drilled.
  - `one-sided board has no top pads`: `pads.top.length === 0`.
  - `every part has a body and one leg per pin`: on board 2, there are one or more body prims tagged `part` per part, and `legs per part === placePart(p).pins.length`. Each leg cylinder runs from at or below the body bottom to y = −1.6 − 1.5.
  - `body sits on the board at real size`:
    - a DIP-8 box has footprint height 4.5 and centre y > 0;
    - a lying axial is a cylinder of diameter 2.5 along the lead axis, with its axis length equal to the body rect's long side;
    - a standing axial is a vertical cylinder of height 7 over lead a.
  - `every leg is soldered underneath`: one `cone` tagged `joint` with `up: -1` at each leg hole on the bottom.
  - `unknown footprint is skipped and reported`: a part with `footprint: 'nope'` gives no prims, and `skipped` names it. The other parts are still built.
  - `empty board`: no parts, trails or wires gives the slab and holes only, and the bounds are finite.
- [ ] **Step 2:** Run `pnpm vitest run tests/core/scene3d-board.test.ts tests/core/scene3d-parts.test.ts`. Expect FAIL: the module is missing.
- [ ] **Step 3: Implement.** Build part bodies from `placePart(p).bodyRectMm` (board mm, already rotated), at height `bodyHeightMm`. Shape per footprint id:
  - relay: box;
  - TO-220: a body box 4.5 thick, plus a metal tab plate 1.3 thick, `#c0c4c8`, on the `tab` side, 6 mm taller than the body;
  - DIP-8: a black box lifted 0.5 above the board;
  - terminal block: green `#2f8f4e` box;
  - header: a black bar 2.5 tall, plus pins as square posts up to the footprint height;
  - polyfuse: a thin yellow box, standing;
  - axial: a cylinder along the lead axis, sitting on the board, beige `#d9c7a0` for resistors (value ending in Ω or containing k/M), black with a grey stripe band at lead b for diodes;
  - disc capacitor: a short vertical cylinder whose disc faces along the lead axis, orange `#d9822b`.

  Legs are cylinders at each pin hole. Two-lead lying parts get bent legs, as a tube: down from the body axis height, then horizontal to the hole, then down through it. A standing axial's lead b runs up the side of the body and over the top, as a tube.
- [ ] **Step 4:** Run the same tests. Expect PASS. Then run `pnpm test`, `pnpm typecheck` and `pnpm lint`.
- [ ] **Step 5:** Commit `feat(core): 3D scene model — board, parts, legs`.

### Task 2: Conductors in the scene

**Files:**
- Create: `core/scene3d/conductors.ts`, and wire it into `buildScene`.
- Test: `tests/core/scene3d-conductors.test.ts`.

**Interfaces:**
- Consumes: Task 1's types and dims; `walkHoles`, `parseHole` and `holeMm`; `buildConnectivity` (for the net on each conductor tag: `groups[...].nets[0]`, or null when shorted or bare).
- Produces: prims tagged `trail`, `wire`, `joint`, `fold` and `bridge`, appended to `Scene3D.prims`.

**Rules:**
- **Bare trail.** A `tube` of radius 0.3 through its corner points.
  - Bottom side: it lies on the bottom surface at y = −1.6 − 0.3.
  - Top side: it lies at y = +0.3.
  - Each joint, and each trail end, gets a solder `cone` on that side. On the bottom it points down (`up: -1`, base at y = −1.6); on the top it points up (base at y = 0).
  - Joints on a one-sided board's top are impossible, since the schema rejects them. A top trail's ends on a one-sided board get their cone on the bottom, with a short vertical cylinder through the hole.
- **Laid wire.** A tube along its walked path.
  - Each segment index in `bareSegments` is a bare tube: radius 0.3, copper.
  - The others are insulated: radius 0.7, wire colour.
  - Insulated stretches lie at y = ±0.7 on their side.
  - Where the wire passes over a hole that another conductor on the same side occupies (a trail, or another wire's path or end), it is lifted. Over that hole it rises by the other conductor's diameter, ramping over ±1 pitch, so the tubes never intersect.
  - Each end goes down through its hole, as a vertical cylinder, to a cone on the opposite side.
- **Flying wire.** An insulated tube on a smooth arc between its two end holes, with 16 or more points.
  - Peak height above the surface on its side: `min(15, max(3, bench.flyingSlackMm / 2))`.
  - Ends go through the holes as for laid wires.
  - If both ends are in the same hole, skip it with a `skipped` note.
- **Leg fold.** A leg tube on the bottom: from the leg hole, flat along the surface to the target hole, with a cone at both holes.
- **Solder bridge.** One flattened `box` of solder colour `#c8c8c8` spanning the two holes, on its side.
- Trails of 1 point, or with zero length, add nothing and get a `skipped` note.

- [ ] **Step 1: Write the failing tests.**
  - `bottom trail lies under the board`: every tube point of a bottom trail has y = −1.9 ± 0.01. A 3-point L trail has 3 corner points (a walk without the intermediate holes is fine), and a cone at each end and each joint.
  - `top trail on a one-sided board is soldered underneath`: there is no cone with `up: 1`, and each end has a through-hole cylinder plus a bottom cone.
  - `mixed wire alternates bare and insulated`: a laid wire with `bareSegments: [0, 2]` over 3 segments gives tubes in the order bare, insulated, bare, with radii 0.3, 0.7, 0.3.
  - `laid wire lifts over a crossing`: a top laid wire crossing a top trail's hole has its tube y at that hole ≥ 0.6 + 0.7. It is back at 0.7 two pitches away.
  - `flying wire arcs`: the max tube y is between 3 and 15. Both ends are at the end holes' x and z.
  - `flying wire with both ends in one hole is skipped`, with a note.
  - `leg fold and solder bridge`: board 2's 12 leg folds give 12 `fold` tubes on the bottom, plus their cones. A solder bridge gives one box between its holes.
  - `conductor tags carry the net`: on board 2, a trail tagged `trail` has the same `net` as `buildConnectivity` for its group.
- [ ] **Step 2:** Run `pnpm vitest run tests/core/scene3d-conductors.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run it again. Expect PASS. Then run `pnpm test`, `pnpm typecheck` and `pnpm lint`.
- [ ] **Step 5:** Commit `feat(core): 3D scene — trails, wires, joints, folds, bridges`.

### Task 3: The 3D view in the editor

**Files:**
- Modify: `package.json`. Add `three`, `@tresjs/core`, `@tresjs/cientos` and `@types/three`, at the latest stable versions that support Vue 3.5. Pin the exact versions pnpm resolves, and record them in the report.
- Create: `app/utils/scene3dThree.ts`, `app/utils/cameraPresets.ts` and `app/components/Board3D.vue`.
- Modify: `app/components/Toolbar.vue` (the `3D` button) and `app/pages/index.vue` (view `'3d'`, rendered with `<ClientOnly><LazyBoard3D …/></ClientOnly>`).
- Test: `tests/app/cameraPresets.test.ts` and `tests/app/scene3dThree.test.ts`. three runs in Node, so no DOM or WebGL is needed.

**Interfaces:**
- Consumes: `buildScene(board): Scene3D`.
- Produces:
  - `cameraPreset(scene: Scene3D, which: 'top' | 'bottom' | 'iso', aspect: number): { position: V3, target: V3, up: V3 }`;
  - `buildMeshes(scene: Scene3D): { group: THREE.Group, dispose(): void }`. Holes and pads use `InstancedMesh` (holes as dark discs on both surfaces, pads as thin copper rings). Each prim mesh carries `userData.tag`;
  - `webglAvailable(): boolean`.

**Behaviour:**
- **Toolbar:** a `3D` button next to `Both sides / Top / Bottom`, plus key `3`. In 3D view the editing tools are disabled, with the title "The 3D view is for looking: switch back to edit".
- **Camera:** presets `Top`, `Bottom` and `Iso` as buttons over the canvas. Orbit, pan and zoom use OrbitControls, with the target at the board centre. Light: one ambient and two directional lights, one above and one below, so the solder side is lit.
- **Live updates:** rebuild the meshes when the `board` changes. Dispose the old geometries and materials, and keep the camera and controls where they were.
- **Fallback:** if `webglAvailable()` is false, show "3D view needs WebGL, which this browser has turned off." with a button back to `Both sides`.

- [ ] **Step 1: Write the failing tests.**
  - `bottom preset matches the mirrored 2D view`: project hole A1 and hole A{cols} with the bottom preset camera, using `THREE.PerspectiveCamera` and `Vector3.project`. A1 must appear to the right of A{cols}, and row A must appear at the top of the screen.
  - `top preset`: A1 appears left of A{cols}, and row A is at the top.
  - `iso preset sees the whole board`: all 4 slab corners project inside NDC [−1, 1].
  - `buildMeshes makes one mesh per prim plus the instanced holes and pads`, and every prim mesh has `userData.tag`.
  - `dispose releases everything`: after `dispose()`, every geometry and material it created has had `.dispose` called (spy on the prototypes).
- [ ] **Step 2:** Run `pnpm vitest run tests/app/cameraPresets.test.ts tests/app/scene3dThree.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** If TresJS has no release that works with Nuxt 4.6 and Vue 3.5, use plain three.js in `Board3D.vue` (a canvas, a `WebGLRenderer` and `OrbitControls` from `three/examples/jsm`) and say so in the report. TresJS was Claude's call in the spec, not the owner's.
- [ ] **Step 4:** Run the tests, then `pnpm test`, `pnpm typecheck` and `pnpm lint`. Check that `nuxi build` output still has three.js only in a lazy chunk: grep the entry chunk for `WebGLRenderer`, and expect no match.
- [ ] **Step 5: Verify in the browser.** Use port 3002 with `WIREBENDER_BOARD` pointing at a scratch copy of the fixture. Never use ports 3000 or 3001, and never touch `data/channel-board-2.wirebender.json`. Take screenshots of:
  - the Iso, Top and Bottom presets of board 2. The Bottom view should look like the mirrored 2D bottom view;
  - the camera unchanged after editing the scratch board file (add a trail with a one-line JSON edit);
  - `renderer.info.memory.geometries` before and after 10 rebuilds, which should be flat;
  - WebGL forced off, showing the fallback message.
- [ ] **Step 6:** Commit `feat: 3D view of the board`.

### Task 4: Hover to inspect, net highlight and finding marks

**Files:**
- Modify: `app/components/Board3D.vue` and `app/pages/index.vue`.
- Test: `tests/app/scene3dThree.test.ts`, adding `highlight` tests.

**Interfaces:**
- Consumes: the page's existing `highlight` group logic, from connectivity, and `markHoles` from the findings panel.
- Produces:
  - `Board3D` props: `board`, `highlightNets: string[]` and `markHoles: Hole[]`;
  - `Board3D` emits `hover-tag(tag: Tag | null)`;
  - `setHighlight(meshes, nets: string[])` in `scene3dThree.ts`. Meshes whose tag net is not in `nets` are dimmed (opacity 0.25). An empty `nets` array restores all of them.

**Behaviour:**
- **Hover:** raycast on pointer move, throttled to one cast per animation frame. The hovered mesh's tag shows in a small tooltip, in the same style as the 2D one: the part ref and value, `ref pin N` with its net for a leg, or the trail or wire id with its net.
- **Highlight:** hovering a conductor or leg highlights its net, the same way 2D does.
- **Findings:** the picked finding's holes get red dashed rings on both surfaces, the same marks as 2D.

- [ ] **Step 1: Write the failing tests.**
  - `setHighlight dims other nets and restores`;
  - `finding marks make rings at the holes on both sides`.
- [ ] **Step 2:** Run the tests. Expect FAIL. **Step 3:** Implement. **Step 4:** Expect PASS. Then run the full suite, typecheck and lint.
- [ ] **Step 5: Verify in the browser.** Hover a GND trail, and only the GND net stays bright. Pick a finding in the panel, and its holes are ringed in 3D. Take screenshots.
- [ ] **Step 6:** Commit `feat(3d): hover inspect, net highlight, finding marks`.

### Task 5: Better connector, header and package models (nice-to-have)

**Files:**
- Modify: `core/scene3d/parts.ts`.
- Test: `tests/core/scene3d-parts.test.ts`.

**What:** more realistic detail, still built from primitives:
- **Header:** a black plastic bar with a chamfer, made from 2 boxes. Square 0.64 mm gold `#d4af37` posts, 6 mm above the bar and 3 mm below the board, plus a pin-1 marker triangle.
- **Terminal block:** a green body, a screw head (a grey cylinder with a slot box) on top of each position, and a dark wire-entry box on the wire side.
- **TO-220:** the tab gets its 3.6 mm mounting hole (as a ring: 4 boxes around a gap, or a cylinder with the hole colour on top). The legs get the standard 90° kink, 2.5 mm under the body.
- **DIP-8:** a pin-1 dot and a notch on the end at pin 1. The legs are flat 0.5 × 0.25 boxes that bend down.
- **Relay:** a pin-1 mark on the top.
- **Diode:** the cathode band is placed at the `stripe-b` lead end.

- [ ] **Step 1: Write the failing tests.** Check:
  - `header has a gold post per pin`;
  - `terminal block has a screw per position on top`;
  - `TO-220 tab has its mounting hole on the tab side`;
  - `DIP-8 pin-1 notch is at pin 1 after rotation` (for rotations 0 and 90);
  - `diode band sits at lead b`.
- [ ] **Step 2:** Expect FAIL. **Step 3:** Implement. **Step 4:** Expect PASS, then run the full suite.
- [ ] **Step 5:** Re-take the Iso screenshot of board 2 for the report.
- [ ] **Step 6:** Commit `feat(3d): detailed headers, terminals, TO-220, DIP`.

---

## After this plan

Milestone 3 is done when the owner has looked at channel board 2 in 3D from both sides and
judged it at least as useful as perfwire's 3D view. The next plan is M4: the hosted static version and the `wirebender/1` open format (spec §11).
