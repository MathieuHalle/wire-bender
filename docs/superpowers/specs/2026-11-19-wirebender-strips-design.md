# WireBender: stripboard and breadboard — design (short)

## Intent

Every connection on a WireBender board today is one the owner drew: a trail, a wire, a folded
leg. Stripboards (Veroboard) and breadboards come with copper already joining rows of holes. The
owner wants to draw both as they are. Agreed 2026-11-16 (stripboard), widened to breadboards
2026-11-19. Owner's calls (2026-11-19): strips are an **explicit list** in the file; a stripboard
is cut **at a hole**; the check **proposes** cuts and the owner places them; breadboard presets for
the **full (830), half (400) and mini (170)** boards. The other calls are mine, marked for the
owner to check.

Three steps, each one released on its own:

1. **Strips:** built-in copper in the board file, in connectivity, the checks, 2D and 3D.
2. **Breadboard:** a board type with nothing soldered, and the three presets.
3. **Stripboard:** cuts, the Cut tool, cut proposals, and cuts on the bench sheet.

## Goals

- `board.strips` lists the copper the board comes with. Every hole on a strip is joined to the
  others on it, as if a trail were soldered at each one.
- Shorts, opens and nets take strips into account. A strip joining two nets is a short, like any
  other.
- **Breadboard:** parts and jumper wires plug in. Nothing is soldered, so there are no trails,
  joints, leg folds or solder bridges. The bench sheet lists where each part and jumper goes.
- **Stripboard:** the owner cuts strips at holes with a Cut tool. When a strip joins two nets,
  the finding names the holes where a cut would separate them. The bench sheet lists the cuts
  first, before anything is soldered.
- 2D and 3D show the copper: strips under the holes on a stripboard, and the clip groups and the
  red and blue rails on a breadboard.

## Non-goals

- Two-sided stripboards, strips on the top side, and pad-per-hole boards with strips on top
  ("tri-pad"). The list format can hold these later.
- Cutting between holes with a knife (owner: cuts are at holes).
- An auto-cut button that places every proposed cut (owner: proposals only).
- Breadboards other than the three presets, and anything not on a 2.54 mm grid.
- Changing an existing board into a stripboard or breadboard in the app (a PUT through the API
  can).

## Anti-goals

- Copper the drawing doesn't show. A hole that is joined must look joined, on both sides and in
  3D.
- Strip noise. The adjacency and keep-away checks must not report every hole of two strips side by
  side.
- Old boards changing meaning. Without `strips`, a board reads and checks exactly as today.

## The format (my calls)

```json
"board": { "cols": 63, "rows": 20, "pitchMm": 2.54, "type": "breadboard", "blocked": [],
           "shape": { "kind": "strips" },
           "strips": [{ "from": "F1", "to": "J1" }, { "from": "A3", "to": "A62" }] }
"cuts": ["C7", "C12"]
```

- **`board.strips`** (optional): each strip is `{ from, to }` along one row or one column. It
  covers every hole in between, like a trail. Strips may not overlap, and every one of their holes
  must exist (shape, range). On a one-sided board strips are bottom copper. On a breadboard they
  are the clips inside the holes.
- **`board.type: "breadboard"`:** a third type. It may have no trails, no leg folds, no solder
  bridges and no wire joints; wires are jumpers whose ends plug in. A lead or a wire end in a hole
  joins that hole's strip. A breadboard has no sides: it is drawn from the top only.
- **`shape: { "kind": "strips" }`:** only the holes on a strip exist. This gives a breadboard its
  centre gap, the space before the rails and the gaps between rail groups, using the same
  `holeExists` as round boards. The holes in between are not drawn and the tools refuse them.
- **`cuts`** (top level, a list of holes, stripboard only): the copper around that hole is
  removed. The strip is in two parts on either side of it, and the hole joins nothing on the
  bottom. A cut must be on a strip hole. A lead in a cut hole is a check warning (nothing to
  solder it to), not a format error.
- The format stays `wirebender/1`: these are new optional fields, and an older reader refuses
  them instead of half-reading them (format rule).

## Connectivity (my calls)

- A strip is one conductor in `buildConnectivity`. It joins the bottom pad of each of its holes,
  except cut ones. On a stripboard every strip hole has copper, so a lead there is soldered to the
  strip.
- **The contact rule:** a bare trail or a bare wire stretch on the bottom touches the copper of
  every strip hole it crosses, as it touches solder today. Through the existing contact findings,
  a bare wire laid across strips is reported.
- On a breadboard the same code applies with the strip as the clip. With no trails and no bare
  copper, nothing else changes.

## Checks (my calls)

- **Strip short + cut proposal:** when a strip's group has more than one net, the finding lists, for
  each span between two leads of different nets on that strip, the free holes where a cut would
  split them. On a breadboard there are no cuts: the finding says which part to move (for example,
  a DIP chip that doesn't straddle the gap).
- **A lead or wire end in a cut hole:** a warning.
- **A cut nothing needs:** a note when both sides of the cut carry the same net or nothing.
- **Adjacency and keep-away:** strips side by side are reported once per pair of strips (with the
  closest holes), not once per hole.
- Findings still end with the advisory line.

## The app (my calls)

- **New board:** stripboard presets (sizes to confirm, see the questions below) and the three
  breadboards. The custom size gets a "Copper" choice: none (perfboard) or strips along the rows.
- **Stripboard:** a **Cut** tool that toggles a cut at a hole on the bottom side. A cut is drawn
  as a bare ring with no copper. Proposed cuts from a finding show as dashed rings, and clicking
  one places it.
- **Breadboard:** the trail pencil and the fold tool are hidden. The wire tool makes jumpers. The
  bottom side is not shown.
- **3D:** copper strips on a stripboard's bottom, with the cuts removed. A breadboard is a white
  block with its holes and red and blue rail lines, and parts and jumpers standing in it.
- **Bench sheet:** a stripboard lists the cuts first, as a checklist with hole names. A breadboard
  lists each part's holes and each jumper's ends and length, and no solder steps.
- **MCP / API:** `create_board` and `POST /api/boards` take the new preset ids. Boards are still
  read and written whole.

## Questions for the owner

1. **Breadboard row names.** On a breadboard's grid, the rails and gaps take rows too, so the
   printed row `a` would be WireBender's row `D` or so. Should a breadboard show its printed names
   (`a`–`j`, `+`, `-`) on the edges? My call: yes, by a display-only label list in the preset,
   while the file keeps grid names. The other choice is to keep grid names everywhere.
2. **Breadboard measurements.** I need the rail layout from a real board: how many holes per rail
   group and how far the rails sit from rows `a` and `j`. On the 830, whether the rails are split
   in the middle. Same as the `proto-4x6` count: to confirm before release.
3. **Stripboard sizes.** Which stripboards do you use (strips × holes, strip direction)? Those
   become the presets.
4. **Order.** Breadboard first (smaller, it tests strips without a new tool), then stripboard. Or
   stripboard first, as first agreed.
