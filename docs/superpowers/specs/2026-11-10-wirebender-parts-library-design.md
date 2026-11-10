# WireBender parts library, batch 1 — design

## Intent

Makers build perfboards from a small set of through-hole parts that WireBender does not
have yet. Batch 1 adds the most used ones (the owner approved the list on 2026-11-10), each
with a 2D body and a 3D model at the detail level of the current parts or better. Real 3D
model files (KiCad / EasyEDA) stay out: every shape is still built in code (`core/`).

## Goals

- Families instead of single parts: one definition with a size covers a line of parts.
- The parts in the table below, usable from the API / MCP like any footprint today.
- Two new 3D shape kinds, `extrude` and `lathe`, so round and D-shaped bodies look right.
- Checks (keep-away, body overlap, tab contact) work on the new parts with no new rules.

## Non-goals

- Model files, a part picker in the app, modules (Arduino Nano, ESP32, buck boards), off-grid
  pitches (JST-XH 2.5 mm, 3.5 mm terminals), rework of the existing parts' 3D shapes.

## Anti-goals

- A board that opened before no longer opens, or looks different: existing ids keep their
  exact geometry (`header-1x5`, `dip8`, `terminal-2p-508` included).
- A change to the board format (footprint ids stay strings; no new keys).

## Parts

Pin offsets are in holes from pin 1 at rotation 0 (x right, y down). Two-lead parts use
pins `a` and `b`; `b` is always the cathode or minus (as for the diode today).

| Ids | Pins | Notes |
|---|---|---|
| `header-1xN`, N 1–40 | `1`…`N` in a row | today's 1x5 geometry, any length |
| `header-2xN`, N 1–40 | odd `1,3,5…` row 0, even `2,4,6…` row 1 | pin 2 under pin 1 (the usual IDC numbering) |
| `socket-1xN`, `socket-2xN` | as the headers | female headers: 8.5 mm tall body, a hole on top of each pin |
| `dipN`, N even 4–40 | today's DIP numbering, rows 3 holes apart (0.3") | `dip8` unchanged |
| `dipN-wide`, N even 24–40 | rows 6 holes apart (0.6") | ATmega1284, Z80, EPROMs |
| `dipN-socket`, `dipN-wide-socket` | as the chip | the chip in a turned-pin socket: 3 mm higher |
| `terminal-Np-508`, N 2–6 | `1`…`N`, 2 holes apart | `terminal-2p-508` unchanged |
| `led-3mm`, `led-5mm` | `a` anode, `b` cathode, 1 hole apart | round body, flat rim on the cathode side, 1 mm off the board |
| `cap-elec-DxH` for 5x11, 6.3x11, 8x12, 10x16, 10x20 | `a` +, `b` −; 1 hole apart up to 6.3, 2 holes for 8 and 10 | round can on the board, minus stripe on the `b` side |
| `to92` | `1`, `2`, `3` in a row | D-shaped body, flat face mark `flat`, 3 mm leg stand-off |
| `button-6x6-hH` for H 4.3, 5, 7, 9.5, 13 | `1` (0,0), `2` (3,0), `3` (0,2), `4` (3,2) | `1`–`2` and `3`–`4` are joined inside; pressing joins them |
| `trimmer-3296w` | `1`, `2` (wiper), `3` in a row | 9.5 x 4.8 x 10, adjust screw on top |
| `trimmer-3362p` | `1`, `2` (wiper), `3` in a row | 6.8 x 7 x 4.5 square, round dial on top |
| `relay-srd` | `C1`, `C2` (coil), `COM`, `NO`, `NC` | Songle SRD-05VDC-SL-C, 19 x 15.5 x 15; pins snapped to the grid |

Heights are the part's highest point above the board, as `heightMm` is today.

## How (decided)

- `core/footprints.ts` builds `FOOTPRINTS` from family generators plus the single parts.
  `Footprint` gets a `shape` field naming its 3D builder; `partPrims` switches on it.
- New marks: `flat-b` (LED: flat rim at lead b) and `minus-b` (electrolytic: stripe at lead
  b). The bench sheet names them `cathode (flat side) at <hole>` and `minus (stripe) at <hole>`.
- A round body (`body.round`) draws as a circle in 2D whether or not the part is standing.
- New prims `extrude` (an outline in x/z, from y0 to y1) and `lathe` (a profile of
  radius/height points spun round a vertical axis), both in `core/scene3d/types.ts`, bounds
  in `sceneBounds`, meshes in `app/utils/scene3dThree.ts`.
- `docs/format/wirebender-1.md` lists the families by pattern.

## Left to the builder

Colours, the exact small details (dome segments, chamfers), and any dimension the table
leaves out, taken from a common datasheet for the part.
