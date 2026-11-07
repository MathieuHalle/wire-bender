# WireBender

WireBender is a local Nuxt app for planning hand-soldered perfboards: you draw wires and parts on a hole grid, and it checks the wiring with the same engine in the browser and on the command line. Findings are advisory only: check the board with a meter before powering it.

## Run it

```sh
pnpm install
pnpm dev                # http://localhost:3000
PORT=3002 pnpm dev      # another port
```

`pnpm dev` runs in local mode and listens on the network (`--host`), so a tablet on the same Wi-Fi can open `http://<this computer's LAN address>:<port>`. Open the board list, import a `.wirebender.json` file or start a new board. Boards are live: every open copy updates as you edit, and a copy that loses the server goes read-only (`Reconnecting… editing is paused`) until it is back.

Check a board file from the terminal with `pnpm check path/to/board.wirebender.json`.

Dev-mode exposure: because of `--host`, the dev server shows the project source to anyone on your LAN. Board data files are blocked. Run it on networks you trust.

`WIREBENDER_BOARD` is gone: the app no longer reads or writes a board file. Boards live in the server's database; import and export files from the board list (or `GET /api/boards/:id/download`).

## Data and backups

Everything is stored in `WIREBENDER_DATA` (default `./.data`, which git ignores):

- `wirebender.sqlite`: all boards, their revision history and the paired devices.
- `backups/`: the server writes `pre-migration-<time>.sqlite` here before it changes the database layout.

Revisions are only ever added, never edited or deleted. To back up, stop the server and copy the whole data folder. To restore, put the folder back. Use `WIREBENDER_DATA=/some/folder pnpm dev` to keep experiments apart from your real boards.

## Pair a device

Requests from this computer (`localhost`) are trusted. Any other device must pair once:

1. On this computer, open a board and choose **Pair a device**. It shows a 6-digit code and a QR code.
2. On the tablet, open the address shown (`http://<LAN address>:<port>/pair`), enter the code and a name for the device. The code works once and expires after 10 minutes; after 5 wrong tries from one address it is refused for a while.
3. The tablet now lists the boards and edits live. Its edits are recorded as `Local · <device name>`.

**Paired devices** lists them; **Unpair** makes the device's next request fail with `401`.

## API

JSON over HTTP, for the app and for scripts (Claude reads and writes boards this way). Callers must be trusted or paired, and a foreign `Origin` or `Host` is refused.

| Route | Does |
| --- | --- |
| `GET /api/boards` | list boards (`id`, `name`, `head`, ...) |
| `POST /api/boards` | `{ "board": <board json> }` imports; `{ "name", "cols", "rows", "type" }` creates an empty board |
| `GET /api/boards/:id` | `{ id, name, head, board }` |
| `PUT /api/boards/:id` | `{ "board": <board json>, "baseRevision"?: n }`; `409` with `{ current }` if `baseRevision` is not the head |
| `PATCH /api/boards/:id` | `{ "name" }` renames |
| `GET /api/boards/:id/check` | findings and counts, as in the findings panel |
| `GET /api/boards/:id/bench` | bench sheet (HTML) |
| `GET /api/boards/:id/download` | the board as a `.wirebender.json` file |
| `GET /api/boards/:id/revisions` | history; `POST /api/boards/:id/revisions/:n/restore` restores one |
| `POST /api/boards/:id/undo`, `/redo` | undo or redo the last change |

Every API write is its own revision (`how: api`) and shows live in open tabs.
