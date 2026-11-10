# The `wirebender/1` board file

A WireBender board is one JSON file. This page describes it for anyone writing another tool that reads or writes these files. The app, the CLI and the API all use the same format.

- JSON Schema: [wirebender-1.schema.json](wirebender-1.schema.json) (generated from the code with `pnpm schema`; a test fails if it drifts).
- Examples: [minimal.wirebender.json](examples/minimal.wirebender.json) (one resistor) and [channel-board-2.wirebender.json](examples/channel-board-2.wirebender.json) (a real two-sided board with trails, wires and rules).

Files are UTF-8 JSON, usually written with 2-space indent and a trailing newline, and named `<board name>.wirebender.json`. A file is at most 2 000 000 bytes.

## Strict objects

Every object is strict: a key this page does not list is an error. Do not add your own keys. If you need to keep extra data, keep it outside the board file.

Two things are optional when you write a file: `revision` (default `0`) and `bench` (and every key inside it, which get the defaults below). Every other key listed as required must be there. The JSON Schema describes what a reader accepts (zod's input mode), so it does not list `revision` or `bench` as required.

## Units and coordinates

- Lengths named `...Mm` are millimetres.
- Everything else is counted in holes. The hole grid has `pitchMm` between neighbouring holes (2.54 mm is the usual 0.1 inch).
- A hole is named by a row letter and a column number: `B7` is row B, column 7. Rows are letters `A` to `Z`, then `AA`, `AB` and on. Columns start at 1 and have no leading zeros. Row `A` is the first row, `1` is the first column.
- A hole must be inside the board: its column is at most `board.cols` and its row is at most `board.rows`.
- Rows run down the board and columns run across, as seen from the top. `A1` is the first hole, in the top left corner of the top side.
- Trails and laid wires run straight: each step goes along a row or along a column, never diagonally. Flying wires may go anywhere.

## Sides

A side is `"top"` or `"bottom"`. Parts sit on the top. Solder pads are on the bottom, and on the top too when `board.type` is `two-sided`. A `one-sided` board has no top pads, so a top trail, or a joint on a top wire, is an error.

## Top-level fields

| Key | Type | Meaning |
| --- | --- | --- |
| `format` | `"wirebender/1"` | The version tag. Always this exact string. |
| `revision` | integer | Informational. See "The `revision` field". Default `0`. |
| `name` | string | The board's name. |
| `board` | object | The size and type of the perfboard. |
| `netClasses` | object | Groups of nets, by name. The rules refer to classes. |
| `nets` | object | The nets, by name. |
| `rules` | object | `keepAway` and `adjacency` rules for the checker. |
| `parts` | array | The parts on the board. |
| `trails` | array | Bare copper (solder) paths. |
| `wires` | array | Wires. |
| `legFolds` | array | Component leads folded over to another hole. |
| `solderBridges` | array | Solder blobs joining two neighbouring pads. |
| `bench` | object | Settings for the bench sheet (wire lengths and paper). |

### `board`

| Key | Type | Meaning |
| --- | --- | --- |
| `cols` | integer, 1 or more | Number of columns. |
| `rows` | integer, 1 or more | Number of rows. |
| `pitchMm` | number, above 0 | Distance between holes, in mm. |
| `type` | `"one-sided"` or `"two-sided"` | Whether there are pads on the top side too. |
| `blocked` | array | Holes you must not use (mounting holes, cut-outs). Each item is `{ "holes": [hole, ...], "reason": string }`. |

### `netClasses` and `nets`

`netClasses` maps a class name to `{ "color"?: string }`. `nets` maps a net name to `{ "class"?: string, "color"?: string }`. The `class` should name a key of `netClasses`; it puts the net in that class. Readers do not check that it does. Colors are CSS color strings such as `"#d62839"`.

A part pin names a net by its name. If the net is not in `nets`, a reader adds it with `{}`, so you do not have to list every net.

### `rules`

- `keepAway` is an array of `{ "a": string, "b": string, "holes": integer }`. `a` and `b` are net class names. The checker warns when a net of class `a` and a different net of class `b` come within `holes` holes of each other on one side, measured as the larger of the row and column distance (a square, so diagonals count). `holes` is 1 or more.
- `adjacency` is an array of `{ "classes": [string, string], "level": "supply" | "mcu" }`. When nets of the two classes sit in holes next to each other along a row or column (diagonals do not count), the checker reports a caution at that level. It means how bad a short would be: `supply` for a supply line against ground or another supply, `mcu` for a short that could harm a microcontroller pin. Class order does not matter. Neighbouring holes with no rule are harmless.

### `parts`

Each part is an object:

| Key | Type | Meaning |
| --- | --- | --- |
| `ref` | string, not empty | The reference, such as `R1` or `U1`. Unique in the board. |
| `footprint` | string, not empty | The footprint id. It must be one of the built-in ones (below). |
| `at` | hole | The hole of pin 1 (for a two-lead part, lead `a`). |
| `to` | hole, optional | Two-lead parts only: the hole of lead `b`. If left out, the part's minimum span is used, along the row. |
| `rotation` | `0`, `90`, `180` or `270` | Degrees. Required, but only used by footprints with more than two leads; a two-lead part is placed by `at` and `to`. |
| `flip` | boolean, optional | Mirror the part. Like `rotation`, ignored for two-lead parts. |
| `standing` | boolean, optional | Two-lead parts only: stands upright instead of lying down. |
| `value` | string, optional | The value, such as `10k`. |
| `label` | string, optional | A free note. |
| `pins` | object | Maps a pin name to a net name, or to `null` for no net. |
| `roles` | object, optional | Maps a pin name to `"in"`, `"out"`, `"pwr"`, `"oc"` or `"passive"`. It overrides the footprint's default role. A pin with no role is `passive`. |

Built-in footprint ids, with their pin names. `N` stands for a number in the range given; any other number is not an id.

<!-- footprint-list:start -->
- `header-1xN`, `socket-1xN` (N 1 to 40): a male header or a female header (socket), pins `1` to `N` in a row.
- `header-2xN`, `socket-2xN` (N 1 to 40): two rows, odd pins `1`, `3`, … on the first and even pins `2`, `4`, … on the second, pin 2 next to pin 1.
- `dipN`, `dipN-socket` (N even, 4 to 40): a DIP chip, pins `1` to `N/2` down one side and the rest back up the other, the sides 3 holes (0.3") apart. `-socket` is the chip in a turned-pin socket, 3 mm higher.
- `dipN-wide`, `dipN-wide-socket` (N even, 24 to 40): the same with the sides 6 holes (0.6") apart.
- `terminal-Np-508` (N 2 to 6): a screw terminal block, pins `1` to `N`, 2 holes (5.08 mm) apart.
- `relay-g5v2` (`1`, `16`, `4`, `13`, `6`, `11`, `8`, `9`), `to220-gds` (`G`, `D`, `S`).
- `to92` (`1`, `2`, `3` in a row; the flat face toward the next row at rotation 0). The pin order differs between parts (E B C, C B E, …): map each pin to its net.
- `button-6x6-hH` (H 4.3, 5, 7, 9.5 or 13, the height in mm): a 6 x 6 tact switch, pins `1` and `2` 3 holes apart, `3` and `4` 2 rows below them. `1`–`2` and `3`–`4` are joined inside; pressing joins the two pairs.
- `trimmer-3296w` (multi-turn) and `trimmer-3362p` (single turn): pins `1`, `2` and `3` in a row; `2` is the wiper.
- Two-lead parts, pins `a` and `b`: `polyfuse-radial`, `axial`, `cap-disc`, `led-3mm` and `led-5mm` (`a` anode, `b` cathode), and the electrolytic capacitors `cap-elec-5x11`, `cap-elec-6.3x11`, `cap-elec-8x12`, `cap-elec-10x16` and `cap-elec-10x20` (diameter x height in mm; `a` plus, `b` minus).
<!-- footprint-list:end -->

Two-lead footprints have an intended span between `at` and `to`: 2 holes for `polyfuse-radial`, 3 to 6 for `axial`, 1 to 2 for `cap-disc`, 1 for the LEDs and the 5 and 6.3 mm electrolytics, and 2 for the 8 and 10 mm ones. Readers need not enforce it. On a two-lead part with a polarity, `b` is the cathode or minus. The reader refuses a footprint id it does not know.

### `trails`

A trail is bare copper wire laid along the pads. Each is `{ "id": string, "side": side, "points": [hole, ...], "joints": [hole, ...] }`. `points` are the corners of the path, and the trail covers every hole in between. `joints` are the holes where it is soldered to the pad. Without a joint a bare trail is only lying there. Trail and wire ids are unique together.

### `wires`

| Key | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique together with the trail ids. |
| `kind` | `"laid"` or `"flying"` | A laid wire follows the board along rows and columns. A flying wire goes straight over, in the air. |
| `side` | side | The side it lies on. |
| `points` | array of holes, 2 or more | Its corners. The first and last are the ends. |
| `color` | string, optional | Insulation color. |
| `bareSegments` | array of integers | The segments with the insulation stripped, as indexes of a segment's first point (`0` is the stretch from `points[0]` to `points[1]`). Empty for a fully insulated wire. |
| `joints` | array of holes | Holes where the wire is soldered to the pad. |

### `legFolds`

`{ "lead": string, "to": hole }`. A leg of a part is bent over on the bottom side and soldered at `to`. `lead` is the part's `ref`, a dot, and the pin name: `"DA1.b"` is pin `b` of `DA1`.

### `solderBridges`

`{ "side": side, "a": hole, "b": hole }`. A blob of solder joining two pads on one side.

### `bench`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `endLeadMm` | number, 0 or more | `5` | Bare lead at each end of a wire. |
| `bendAllowanceMm` | number, 0 or more | `1` | Extra wire for each bend. |
| `spareMm` | number, 0 or more | `5` | Spare length for each wire. |
| `flyingSlackMm` | number, 0 or more | `10` | Slack for a flying wire. |
| `roundToMm` | number, above 0 | `5` | Cut lengths are rounded up to a multiple of this. |
| `paper` | `"letter"` or `"a4"` | `"letter"` | The paper for the printed sheet. |

## Rules the schema can't express

The JSON Schema covers the shape: keys, types, enums, and number ranges. A reader must also enforce these rules. They are checked in code, so the schema does not show them. Use the checks in `core/schema.ts` (`parseBoard`) as the reference.

- **Hole names.** Every hole is a string like `B7`: capital letters, then a number from 1 with no leading zero. The schema only says "string".
- **Holes in range.** Every hole must lie inside `board.cols` by `board.rows`.
- **Straight steps.** In a trail, and in a laid wire, two neighbouring points share a row or a column. Flying wires are exempt.
- **Known footprints.** `footprint` must be a built-in footprint id.
- **Unique refs and ids.** Part `ref`s are unique. Trail and wire `id`s are unique across both lists together.
- **No top pads on a one-sided board.** A `one-sided` board may have no top trail, and no joint on a top wire.
- **Pins and nets.** A net named by a pin and missing from `nets` is added as `{}`.
- **Integer ranges.** The schema shows the safe-integer bounds (plus and minus 9007199254740991) for integers. Stay well inside them.
- **Defaults.** `revision` and `bench` (and each `bench` key) may be left out and get their defaults. The schema shows this: they are not in its `required` lists.

Any other value is rejected with a list of messages, each naming the path (such as `wires[2].points[1]`). Advisory only: a board that passes these rules can still be wired wrong. Check the board with a meter before powering it.

## The `revision` field

`revision` in a file is informational: a download writes the current revision there, and an import ignores it. A caller that wants "refuse if the board changed" sends `baseRevision` as a separate request field.

## Bundles (`wirebender-bundle/1`)

A bundle is a `.wirebender.zip` file (`application/zip`) that holds a board and its whole history. It is what **Board with history** downloads, and what an import of a zip reads. A bundle imports as a new board with all its revisions.

### Layout

A bundle holds exactly these entries:

| Entry | Holds |
| --- | --- |
| `manifest.json` | `{ "format": "wirebender-bundle/1", "name": string, "exportedAt": number, "revisions": integer }`. `exportedAt` is milliseconds since the epoch. `revisions` is the number of revision files. |
| `board.wirebender.json` | The current board, a normal `wirebender/1` file. |
| `revisions/<n>.json` | One file per revision. `<n>` is the revision number, padded with zeros to 6 digits: `revisions/000012.json`. |
| `revisions/` | An optional directory entry. |

WireBender writes each entry as compact JSON (no indentation). A reader accepts any JSON formatting, so a pretty-printed bundle, from an older version or made by hand, reads the same.

Each revision file is:

| Key | Type | Meaning |
| --- | --- | --- |
| `n` | integer, 1 to 999999 | The revision number. It must equal the number in the file name. |
| `createdAt` | number | When it was made, in milliseconds since the epoch. |
| `author` | string | The author's display name. It is a name only, never an account id or a token id. |
| `how` | string | How it was made: `create`, `import`, `fork`, `edit` (live editing), `api`, `undo`, `redo`, `restore` or `recovered`. |
| `target` | integer, 1 or more, or `null` | For an `undo`, the revision that was undone: the board went back to the one before it. For a `redo`, the revision that was redone: the board is that revision's board again. For a `restore`, the revision restored: the board is that revision's board. Else `null`. |
| `summary` | string | A short description of the change. |
| `board` | board | The board at that revision, a `wirebender/1` file. |

### Strict reading

A reader must refuse a bundle when:

- the `format` in `manifest.json` is not `wirebender-bundle/1`;
- an entry is not one of the names above, or the same name appears twice;
- a revision's file name does not match its `n`;
- the zip's central directory does not list exactly the entries in the file (a cut or damaged zip);
- `manifest.revisions` is not the number of revision files;
- any board or revision does not pass the `wirebender/1` rules above.

The limits are:

- 50 000 000 bytes for the zip;
- 200 000 000 bytes unzipped, all entries together;
- 20 000 revisions;
- 2 000 000 bytes for each board (the current board and each revision's), measured as the board in compact JSON after reading, the same measure as the server's board limit; so any board the server holds fits;
- 2 400 000 bytes for each entry as stored in the zip, whatever its formatting. A pretty-printed entry takes about twice the bytes of its board, so a pretty-printed bundle reads only while its boards are under about 1 100 000 bytes.

An import never keeps an account id or a token id from another server. Imported authors keep their names, marked "imported".

An import makes a new board and renumbers the revisions 1 to N in order of `n` (gaps close up). Each `target` is changed to the new number of the revision it names. It becomes `null` when that revision is not in the bundle, or when it is not older than its own revision. A `how` the server does not know imports as `import`, and so does revision 1 unless it is `create`, `import` or `fork` (there is nothing before it to undo to). The import then adds one more revision, `how` `import`, by the person importing, which holds the bundle's current board.

## Rules for future versions

New fields are additive; breaking changes bump to `wirebender/2`, and old boards are converted when read, with the original kept.

A reader must reject an unknown `format`. Do not guess at a file whose `format` is not `wirebender/1`, and do not read a bundle whose `format` is not `wirebender-bundle/1`. Today the reader also rejects unknown keys, so a file with a field from a newer version is refused by an older reader, not half-read.
