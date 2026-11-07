# WireBender service step 1 (a live board on your own machine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boards live in a SQLite database on the owner's machine. Every open copy of a board (the computer, a paired bench tablet) edits it live through Yjs. Every change is a revision, with a shared undo and a history you can restore from. The board file on disk, its watcher and the conflict banner are gone.

**Architecture:**
- **One write path.** All changes reach the board through the server. Browser edits arrive as Yjs updates over a WebSocket. API calls (`PUT`, undo, redo, restore, import) are written into the same live document by the server.
- **The server keeps the record.** It holds one Yjs document per open board (a "room"). It validates each update with `core/`'s `parseBoard`, saves the current board on every accepted update, and groups updates into revisions.
- **A small binding** in `shared/` maps a `BoardFile` onto Yjs maps, one value per board item. The browser and the server both use it.
- **Local mode.** Loopback is trusted. Other devices on the network must pair once with a code.

**Tech Stack:**
- Nuxt 4 / Nitro, with experimental WebSockets (crossws).
- `yjs`, `y-protocols`, and `y-websocket` (client provider only).
- `drizzle-orm` + `better-sqlite3`, with `drizzle-kit` for migrations.
- `uqr` for the pairing QR code.
- Existing: Vue 3.5, Nuxt UI 4, Vitest.
- Pin exact versions at install time, as the repo already does for three/TresJS.

**Spec:** `docs/superpowers/specs/2026-11-06-wirebender-service-design.md`, §3 (local mode, pairing), §6 (live editing), §7 (revisions, undo, history), §8 (one data folder, nothing overwritten), §9 (the API, without tokens), §12 step 1. Where §11 of that spec says so, it overrides `2026-11-05-wirebender-design.md`.

## Global Constraints

- All earlier constraints still apply:
  - `core/` has no Vue, Nuxt, Node `fs`, DOM or Yjs imports;
  - the UI is in English;
  - hole names look like `G13`;
  - findings end with the advisory sentence;
  - `reference/` is read-only.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01J81HjJ6887eqExbmYEf29H`.
- Yjs code lives in `shared/` (alias `#shared`, added to `vitest.config.ts` too) and in `app/` and `server/`, never in `core/`.
- **Mode:** `WIREBENDER_MODE` must be `local` in step 1. `pnpm dev` sets it, and also passes `--host` so the tablet can reach the server. Any other value stops the server at start with `public mode arrives in step 2; set WIREBENDER_MODE=local`.
- **Data folder:** `WIREBENDER_DATA`, default `./.data` (already gitignored). The database is `<data>/wirebender.sqlite`; backups go in `<data>/backups/`.
- **Nothing is overwritten** (spec §8): revisions are only ever inserted, never updated or deleted, and the board's current state is saved on every accepted update.
- **Disconnected copies are read-only** (spec §6): no edit is queued while offline.
- **Revision grouping:** live updates from one author join one revision until that author has sent nothing for `GROUP_IDLE_MS = 2000`, or disconnects. Every API write is its own revision, and closes any open group first.
- **Pairing codes:** 6 digits, single use, expire after 10 min. At most 5 wrong attempts per remote address per 10 min; after that, `429`.
- **The `revision` field** of a board the API returns is the board's head revision number; an import ignores it (spec §7).
- The CLI's `check` and `export` on files stay unchanged.

## Review Focus

1. **An update that breaks the board** (a trail point off the board, two parts with the same ref after a merge, garbage bytes on the socket) must be rejected. The sender is disconnected with a reason, then resyncs from the server's state. Other clients never see the bad state. → Task 4 test `invalid update is rejected and others are untouched`.
2. **A server restart while tabs are open** must not lose the last edits. Updates since the last revision are saved as the board's current state, and committed as a "recovered" revision when the room opens again. The tabs go read-only, reconnect and resync on their own. → Task 3 test `edits since the last revision survive a restart`; Task 9 browser check.
3. **Undo right after a live edit that is still grouping** must undo that edit, not the one before it. → Task 3 test `undo closes the open group first`.
4. **An import of something that is not a valid board** (bad JSON, schema errors, a 50 MB file) gets `422` with the parse errors (or `413` over `MAX_BOARD_BYTES = 2_000_000`), and creates nothing. → Task 5 test `bad import creates nothing`.
5. **An unpaired device on the network** gets `401` from the API and the WebSocket, even if it sends `X-Forwarded-For: 127.0.0.1`. Loopback means the socket's remote address, never a header. → Task 7 test `forwarded header does not make a request local`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `shared/yboard.ts` | `BoardFile` ⇄ Yjs document binding; item keys; diff writes |
| `shared/summary.ts` | one-line summary of the change between two boards |
| `shared/undoState.ts` | the shared undo/redo stack, worked out from the revision list |
| `server/db/schema.ts`, `server/db/index.ts`, `server/db/migrations/` | Drizzle schema, opening the db, migrations with a backup first |
| `server/utils/boards.ts` | board and revision storage (create, import, current state, revisions) |
| `server/utils/rooms.ts` | live rooms: Yjs doc per open board, validation, grouping, server writes |
| `server/utils/access.ts` | local-mode trust: loopback or paired device; pairing codes |
| `server/routes/_ws/board/[id].ts` | WebSocket: y-protocols sync + awareness, per room |
| `server/api/boards/**` | the API (Task 5 lists the routes) |
| `server/api/pair*.ts`, `server/api/devices/**` | pairing and paired devices |
| `server/middleware/access.ts` | blocks untrusted requests |
| `server/plugins/startup.ts` | mode check, db open + migrate, recover rooms on start |
| `app/composables/useLiveBoard.ts` | replaces `useBoard.ts`: provider, read-only state, apply, undo/redo |
| `app/pages/index.vue` | board list (new) |
| `app/pages/b/[id].vue` | the editor (moved from today's `index.vue`) |
| `app/pages/pair.vue` | enter a pairing code |
| `app/components/HistoryPanel.vue`, `PairDialog.vue`, `PresenceBar.vue` | history tab, pairing dialog, who is here |
| Removed | `server/utils/boardFile.ts`, `server/api/board*.ts`, `server/api/board/events.get.ts`, `server/api/bench.get.ts`, `app/composables/useBoard.ts`, their tests, the `chokidar` dependency, `WIREBENDER_BOARD` |

---

### Task 1: Board ⇄ Yjs binding

**Files:**
- Create: `shared/yboard.ts`, `shared/summary.ts`
- Modify: `vitest.config.ts`, `nuxt.config.ts` (the `#shared` alias, if Nuxt 4 does not already resolve it in vitest)
- Test: `tests/shared/yboard.test.ts`, `tests/shared/summary.test.ts`

**Interfaces:**
- Produces:
  - `SECTIONS`: the list sections of a board and how each item is keyed:
    - `parts` → `ref`
    - `trails`, `wires` → `id`
    - `legFolds` → `lead`
    - `solderBridges` → `` `${side}:${a}:${b}` ``
  - `RECORDS`: `nets` and `netClasses`, keyed by name.
  - `SINGLES`: `name`, `board`, `rules`, `bench`.
  - `boardToDoc(doc: Y.Doc, board: BoardFile): void` writes everything into a fresh doc.
  - `docToBoard(doc: Y.Doc, revision: number): ParseResult`: the board rebuilt and run through `parseBoard`.
  - `writeBoard(doc: Y.Doc, before: BoardFile, after: BoardFile, origin?: unknown): void`: one transaction that writes only the items that differ (deep-equal), and deletes the removed ones.
  - `summarize(before: BoardFile | null, after: BoardFile): string`.
- Yjs layout:
  - one `Y.Map` per section and record group, named after the section;
  - a `Y.Map` `"singles"`;
  - a `Y.Map` `"server"`, written only by the server: `{ revision: number, canUndo: boolean, canRedo: boolean }`;
  - each section item is stored as a plain object `{ pos: number, v: item }`. `pos` keeps the file order: `docToBoard` sorts by `pos`, then by key. New items get `max(pos) + 1`.

- [ ] **Step 1: Write the failing tests:**
  - `round trip keeps channel board 2`: `docToBoard(boardToDoc(b2))` deep-equals `b2` (with its revision set to the passed number).
  - `writeBoard writes only what changed`: after moving W5, observe the doc. The one transaction touches only `wires` key `W5`, and nothing in `parts`.
  - `writeBoard deletes removed items and adds new ones at the end`: a new trail gets the highest `pos`; deleting a part removes its key.
  - `two docs editing different trails both land`: two docs are synced both ways (`Y.encodeStateAsUpdate` / `Y.applyUpdate`), each edits a different trail, and afterwards both have both edits.
  - `two docs editing the same trail converge to one of the two`: after a two-way sync both docs agree, and the trail is equal to one of the two versions (never a mix).
  - `summarize`:
    - `summarize(null, b)` is `created`;
    - moving W5 to the top gives `wire W5 changed (top)`;
    - adding T40 and removing T3 gives `trail T40 added; trail T3 removed`;
    - more than 3 changed items gives the first 3 plus `and N more`;
    - no change gives `no change`.
- [ ] **Step 2:** `pnpm vitest run tests/shared` → FAIL (modules missing).
- [ ] **Step 3: Implement** `shared/yboard.ts` and `shared/summary.ts`. Use `pnpm add yjs`; deep-equal through a stable JSON stringify (sorted keys, the same idea as `canonical()` in today's `useBoard.ts`).
- [ ] **Step 4:** `pnpm vitest run tests/shared` → PASS. Then `pnpm test`, `pnpm typecheck` and `pnpm lint`.
- [ ] **Step 5:** Commit `feat(shared): board ⇄ Yjs binding and change summaries`.

### Task 2: Database, data folder, migrations

**Files:**
- Create: `server/db/schema.ts`, `server/db/index.ts`, `server/db/migrations/` (generated), `drizzle.config.ts`
- Modify: `package.json` (deps; script `db:generate`)
- Test: `tests/server/db.test.ts`

**Interfaces:**
- Produces:
  - tables:
    - `boards(id text pk uuid, name text, createdAt int, updatedAt int, current text /* JSON BoardFile */, head int)`;
    - `revisions(boardId text, n int, createdAt int, author text /* display name, e.g. "Local · iPad" */, how text /* 'create'|'import'|'edit'|'api'|'undo'|'redo'|'restore'|'recovered' */, target int null /* the revision an undo/redo/restore refers to */, summary text, board text /* JSON */, pk(boardId, n))`;
    - `devices(id text pk, name text, tokenHash text, createdAt int, lastSeen int)`.
  - `openDb(dataDir: string): Db` creates the folder and opens `wirebender.sqlite` (WAL mode). If any migration is pending and the database already has tables, it first runs `VACUUM INTO '<data>/backups/pre-migration-<ISO time>.sqlite'`, then migrates. A failing migration throws and leaves the database as it was.
  - `useDb(): Db`: the server's single instance, opened from `WIREBENDER_DATA`.

- [ ] **Step 1: Write the failing tests** (each on a temp folder):
  - `opens and migrates an empty folder`: the three tables exist;
  - `a pending migration on a non-empty db makes a backup first`: simulate a pending migration with a test migration folder; a `pre-migration-*.sqlite` file appears and opens;
  - `reopen keeps data`: insert a row, close, reopen, the row is still there.
- [ ] **Step 2:** `pnpm vitest run tests/server/db.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `pnpm add drizzle-orm better-sqlite3` and `pnpm add -D drizzle-kit @types/better-sqlite3`. Generate the first migration with `pnpm db:generate`, and commit it.
- [ ] **Step 4:** → PASS, then the full suite, typecheck and lint.
- [ ] **Step 5:** Commit `feat(server): SQLite data folder with migrations and a backup before each`.

### Task 3: Boards, revisions and the shared undo

**Files:**
- Create: `server/utils/boards.ts`, `shared/undoState.ts`
- Test: `tests/server/boards.test.ts`, `tests/shared/undoState.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 2), `summarize` (Task 1).
- Produces:
  - `undoState(revs: { n: number, how: string, target: number | null }[]): { undo: number | null, redo: number | null }`. It replays the list in order:
    - `edit`, `api`, `restore` and `recovered` push n onto the undo stack and clear redo;
    - `undo` (target k) moves k from undo to redo;
    - `redo` (target k) moves k back to undo;
    - `create` and `import` are the floor and cannot be undone.

    `undo` is the top of the undo stack, `redo` the top of the redo stack.
  - `createBoard(db, board: BoardFile, how: 'create'|'import', author: string): { id: string, head: 1 }`.
  - `getBoard(db, id): { id, name, head, board: BoardFile } | null`, where `board.revision` = head.
  - `saveCurrent(db, id, board: BoardFile): void` stores the current state only (called on every accepted live update; makes no revision).
  - `commitRevision(db, id, r: { board: BoardFile, author: string, how: string, target?: number }): number` inserts revision `head + 1`, with `summary` from `summarize(previous, board)`, sets `current` and `head`, and returns n.
  - `boardBefore(db, id, n): BoardFile` returns revision `n − 1`'s board.
  - `listBoards(db)`, `listRevisions(db, id)` (newest first, without board JSON), `getRevision(db, id, n)`, `renameBoard(db, id, name)`.
  - `recover(db, id): number | null`: if `current` differs from the head revision's board, commits it as a `recovered` revision.

- [ ] **Step 1: Write the failing tests:**
  - `undoState`: an edit-edit-undo-undo-redo sequence gives the expected tops. Undo of the create floor is `null`. A new edit after an undo clears redo.
  - `commitRevision only inserts`: three commits leave three revision rows, and none is updated (compare the earlier rows byte for byte).
  - `undo reverts the latest change, whoever made it`: an edit by "Local", then an API edit by "Claude"; undo restores the board from before Claude's change and records `how: 'undo', target: n`.
  - `edits since the last revision survive a restart`: `saveCurrent` without a commit, reopen the db, `recover` creates a `recovered` revision with that board.
  - `undo closes the open group first` lives in Task 4 (grouping is a room concern); here, `boardBefore` returns the right board.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS, then the full suite, typecheck and lint.
- [ ] **Step 5:** Commit `feat(server): boards, append-only revisions and the shared undo`.

### Task 4: Live rooms and the WebSocket

**Files:**
- Create: `server/utils/rooms.ts`, `server/routes/_ws/board/[id].ts`
- Modify: `nuxt.config.ts` (`nitro: { experimental: { websocket: true } }`)
- Test: `tests/server/rooms.test.ts`

**Interfaces:**
- Consumes: Task 1 binding, Task 3 storage.
- Produces:
  - `openRoom(db, id): Room` (one per board, kept while it has peers). It builds the doc from `getBoard(...).board` after `recover`.
  - `Room.receive(peerId: string, author: string, update: Uint8Array): { ok: true } | { ok: false, reason: string }`. It applies the update to a **copy** of the doc and runs `docToBoard`. It also rejects any change to the `"server"` map. If the copy is valid, it applies the update to the real doc, broadcasts it, calls `saveCurrent`, and (re)starts the author's group timer.
  - `Room.serverWrite(next: BoardFile, meta: { author, how, target? }): number`:
    1. closes every open group;
    2. `writeBoard`s the diff with origin `'server'`;
    3. commits the revision;
    4. updates the `"server"` map (`revision`, `canUndo`, `canRedo`).
  - `Room.undo(author)` and `Room.redo(author)`: both close open groups first, then go through `undoState`, `boardBefore` / `getRevision` and `serverWrite`. They return the new revision, or `null` when there is nothing to undo/redo.
  - `Room.leave(peerId)` closes that author's group. The last leave saves and drops the room.
  - WebSocket: the y-websocket wire protocol (message type 0 = sync, 1 = awareness, through `y-protocols`), so the client can use `y-websocket`'s `WebsocketProvider`. The board id comes from the URL `/_ws/board/<id>`. A rejected update closes that peer with code `4400` and the reason. The author name comes from the access check (Task 7; until then, `"Local"`).

- [ ] **Step 1: Write the failing tests** (rooms driven directly, with two in-memory Yjs docs as "clients"):
  - `an accepted update reaches the other client and is saved`: client A edits T7; client B's doc has it; `getBoard().board` (current) has it.
  - `invalid update is rejected and others are untouched`: A sends a trail point `Z99`; the result is `{ok:false}` with a parse reason; B and the server doc are unchanged. Garbage bytes are rejected too, without throwing.
  - `a client cannot write the server map`.
  - `updates group per author until 2 s idle` (fake timers): A edits 3 times within 1 s, then waits 2 s → 1 revision `how: 'edit'`. Edits by A and B interleaved → 2 revisions.
  - `undo closes the open group first`: A edits, and undo comes 500 ms later. A's edit becomes revision n, and the undo reverts n, not n − 1.
  - `serverWrite reaches clients live and updates the server map`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement (`pnpm add y-protocols lib0`). **Step 4:** → PASS, then the full suite, typecheck and lint.
- [ ] **Step 5: Manual:** `pnpm dev`. Connect with a throwaway script using `y-websocket`'s `WebsocketProvider` from Node, and see the sync complete. Remove the script.
- [ ] **Step 6:** Commit `feat(server): live rooms over WebSocket with validation and revision grouping`.

### Task 5: The API

**Files:**
- Create, under `server/api/boards/`:
  - `index.get.ts` (list), `index.post.ts` (create or import);
  - `[id].get.ts`, `[id].put.ts`, `[id].patch.ts` (rename);
  - `[id]/check.get.ts`, `[id]/bench.get.ts`, `[id]/download.get.ts`;
  - `[id]/undo.post.ts`, `[id]/redo.post.ts`;
  - `[id]/revisions/index.get.ts`, `[id]/revisions/[n].get.ts`, `[id]/revisions/[n]/restore.post.ts`.
- Modify: `server/utils/bench.ts` (it builds from a `BoardFile`, not a path)
- Test: `tests/server/api.test.ts` (calls the handlers' utils, as `tests/server/bench.test.ts` does today)

**Interfaces:**
- Consumes: Tasks 3 and 4. Every write goes through `openRoom(db, id).serverWrite(...)` (or `undo`/`redo`), so open copies update live.
- Produces (JSON):
  - `POST /api/boards`: takes `{ name, cols, rows, type }` (create empty) or `{ board: unknown }` (import) and returns `{ id }`. Errors: `422 { errors }`, or `413` over `MAX_BOARD_BYTES`.
  - `GET /api/boards/:id`: `{ id, name, head, board }`.
  - `PUT /api/boards/:id`: takes `{ board, baseRevision? }` and returns `{ revision }`. Errors: `409 { current }` when `baseRevision` ≠ head, `422 { errors }`.
  - `GET /api/boards/:id/check`: `runCheck` output with the stats line.
  - `GET /api/boards/:id/bench`: the server-built HTML (the tick key uses the board id and head).
  - `GET /api/boards/:id/download`: the `wirebender/1` file, `Content-Disposition` `<name>.wirebender.json`.
  - `POST /api/boards/:id/undo` and `/redo`: `{ revision }`, or `409 { reason: 'nothing to undo' }` / `'nothing to redo'`.
  - `GET /api/boards/:id/revisions`: `[{ n, createdAt, author, how, target, summary }]`. `GET .../revisions/:n`: that revision's board. `POST .../revisions/:n/restore`: `{ revision }`, as `how: 'restore', target: n`.
  - Unknown board → `404`. API writes have author `"Local"` in step 1, and `how: 'api'`.

- [ ] **Step 1: Write the failing tests:**
  - `import then get returns the board with head 1`.
  - `bad import creates nothing`: invalid JSON gives `422`, schema errors give `422 { errors }` listing them, `MAX_BOARD_BYTES + 1` gives `413`; `listBoards` stays empty.
  - `put with a stale baseRevision is 409 and changes nothing`.
  - `put without baseRevision writes a revision how 'api'`.
  - `restore makes revision n the current board as a new revision`.
  - `undo with nothing to undo is 409`.
  - `download sets the filename and returns a board that parses`.
  - `bench returns HTML containing the board name`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS, then the full suite, typecheck and lint.
- [ ] **Step 5:** Commit `feat(api): boards, revisions, undo, check, bench and download`.

### Task 6: The editor on a live board, and the board list

**Files:**
- Create: `app/composables/useLiveBoard.ts`, `app/pages/index.vue` (board list), `app/pages/b/[id].vue`, `app/components/PresenceBar.vue`
- Move: today's `app/pages/index.vue` editor into `app/pages/b/[id].vue`
- Modify: `app/composables/useTools.ts` (use `useLiveBoard`), `app/components/Toolbar.vue`/header (connection badge, presence)
- Delete: `app/composables/useBoard.ts`, `tests/app/useBoard.test.ts`, the conflict and file-error banners
- Test: `tests/app/useLiveBoard.test.ts`

**Interfaces:**
- Consumes: the WebSocket (Task 4), the API (Task 5), `shared/yboard.ts`.
- Produces: `useLiveBoard(id: Ref<string>)` returns:
  - `board: ShallowRef<BoardFile | null>`;
  - `status: Ref<'connecting' | 'live' | 'offline'>`;
  - `readOnly: ComputedRef<boolean>`, true unless `live` and synced;
  - `revision`, `canUndo` and `canRedo` (from the `"server"` map);
  - `apply(next: BoardFile): boolean`: false and no write when read-only; else `writeBoard(doc, board, next)`;
  - `undo()` and `redo()`: POSTs;
  - `peers: Ref<{ name: string, color: string }[]>` (awareness).

  The local awareness user is `{ name: 'Local · ' + deviceName, color }`. The device name is the paired device's name, or `This computer` on loopback.
- Behaviour:
  - Edit tools are disabled while `readOnly`, with the tooltip `Reconnecting… editing is paused`.
  - A `4400` close shows a toast with the reason, discards the local doc, and reconnects fresh.
  - Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z call `undo` and `redo` (the shared stack). The header's `rev N` shows the server revision.
- Board list (`/`):
  - rows: name, last change (time and author), head revision;
  - actions: **New board** (name, cols, rows, one/two-sided), **Import** (file picker; shows the `422` errors), **Open**, **Rename**, **Download**.
  - Empty state: `No boards yet. Import a .wirebender.json file or start a new board.`
  - The bench sheet button opens `/api/boards/:id/bench`.

- [ ] **Step 1: Write the failing tests** for `useLiveBoard`, with a fake provider exposing `doc`, `awareness`, `wsconnected` and `synced`:
  - `apply is refused while offline`;
  - `apply writes only the diff`;
  - `a remote change updates board`;
  - `server map drives revision, canUndo, canRedo`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement (`pnpm add y-websocket`). Then remove `chokidar`, `server/utils/boardFile.ts`, `server/api/board*.ts`, `server/api/board/events.get.ts`, `server/api/bench.get.ts` and their tests. Drop `WIREBENDER_BOARD` from the README.
- [ ] **Step 4:** → PASS, then the full suite, typecheck and lint.
- [ ] **Step 5:** Commit `feat(app): live editor and board list; the file sync is gone`.

### Task 7: Local-mode access and pairing

**Files:**
- Create: `server/utils/access.ts`, `server/middleware/access.ts`, `server/plugins/startup.ts`, `server/api/pair/start.post.ts`, `server/api/pair.post.ts`, `server/api/devices/index.get.ts`, `server/api/devices/[id].delete.ts`, `app/pages/pair.vue`, `app/components/PairDialog.vue`
- Modify: `package.json` (`dev`: `WIREBENDER_MODE=local nuxt dev --host`), the WebSocket handler (Task 4) and the editor header ("Pair a device", "Paired devices")
- Test: `tests/server/access.test.ts`

**Interfaces:**
- Produces:
  - `checkMode(env): void`: throws the exact message from Global Constraints unless `local`. Called from `startup.ts`, before `openDb`.
  - `isLoopback(remoteAddress: string | undefined): boolean`: `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. Headers are never consulted.
  - `trust(event | peer): { ok: true, author: string } | { ok: false }`:
    - loopback → `Local · This computer`;
    - a valid `wb_device` cookie → `Local · <device name>`, and `lastSeen` is updated.
  - `startPairing(): { code: string, expiresAt: number, url: string }`. Only from a trusted request. The `url` uses the first non-internal IPv4 of the machine and the server port, with `/pair` appended. The code is 6 random digits.
  - `completePairing(code, name, remote): { ok: true, cookie: string } | { ok: false, status: 400 | 429 }`. The cookie is httpOnly, `SameSite=Lax`, max-age 1 year; the token is 32 random bytes, stored as its sha256 hash.
  - Middleware: untrusted requests get `401` from `/api/**` (except `POST /api/pair`), a redirect to `/pair` for pages, and `401` on the WebSocket upgrade.
  - `PairDialog` shows the code (large), its expiry countdown and a QR code of `url` (made with `uqr`, rendered as SVG).

- [ ] **Step 1: Write the failing tests:**
  - `checkMode`: `local` passes; unset, `public` or `foo` throws the exact message.
  - `loopback is trusted, a LAN address is not`.
  - `forwarded header does not make a request local`: remote `192.168.1.20` with `X-Forwarded-For: 127.0.0.1` gives `{ok:false}`.
  - `pairing code works once and expires` (fake timers): correct → ok; same code again → 400; a new code after 10 min + 1 s → 400.
  - `five wrong codes then 429`, per remote address, resetting after 10 min.
  - `unpair revokes the cookie`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement (`pnpm add uqr`). **Step 4:** → PASS, then the full suite, typecheck and lint.
- [ ] **Step 5:** Commit `feat(server): local mode, paired devices and pairing codes`.

### Task 8: History tab

**Files:**
- Create: `app/components/HistoryPanel.vue`
- Modify: `app/utils/sidePanel.ts` (a third tab `history`, icon `i-lucide-history`), `app/pages/b/[id].vue`
- Test: `tests/app/sidePanel.test.ts` (new tab id round-trips through storage), `tests/app/historyPanel.test.ts` (pure helpers only)

**Interfaces:**
- Consumes: `GET /api/boards/:id/revisions`, `GET .../revisions/:n`, `POST .../restore`.
- Produces:
  - The list: newest first, each row showing `#n`, a relative time, the author, the summary and `how` as a badge. It reloads when `revision` changes.
  - Selecting a row shows that revision's board read-only: the 2D canvas swaps to it, edit tools are locked, and a banner reads `Viewing #n by <author>. Restore makes it the current board; nothing is lost.` The banner has **Restore** and **Back to current** buttons.
  - Pure helper `revisionLabel(r): string`, e.g. `#42 · Claude · undo of #41`.

- [ ] **Step 1: Write the failing tests:** `revisionLabel` for each `how`, and the side-panel tab round-trip.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS, then the full suite, typecheck and lint.
- [ ] **Step 5:** Commit `feat(app): history tab with preview and restore`.

### Task 9: Channel board 2 in, and the browser check

**Files:**
- Modify: `README.md` (how to run, the data folder, pairing; no more `WIREBENDER_BOARD`), `CLAUDE.md` (Claude reads and writes boards through the running server's `/api/boards`; the file under `data/` is a fixture only)
- No new code, unless the checks below find bugs (fix those with a test first).

- [ ] **Step 1:** `WIREBENDER_DATA=<scratch>/data pnpm dev --port 3002`. Never use ports 3000 or 3001 (the owner's), and never the owner's `.data` folder. Import `data/channel-board-2.wirebender.json` through the board list, and see it open with head `1` and the same check counts as `pnpm check data/channel-board-2.wirebender.json`.
- [ ] **Step 2: Live, two copies.** Open the board in two tabs. Draw a trail in one, and it appears in the other within 1 s. Undo it from the other tab; both update. The history shows `pencil`/`edit`, then `undo`. Take screenshots.
- [ ] **Step 3: Pairing.** Open the server's network address (`http://<LAN IP>:3002`), not loopback; it redirects to `/pair`. Start pairing from the loopback tab, enter the code, and the board list opens. The paired tab edits live. Unpair it from "Paired devices", and its next request gets `401`.
- [ ] **Step 4: Restart.** Make an edit, stop the server within 2 s, start it again. Both tabs go read-only while it is down, come back live, and the edit is there (a `recovered` revision).
- [ ] **Step 5: API as Claude would use it.** `curl -X PUT` the board with W5 changed while a tab is open. The tab shows it live, and the history says `api` by `Local`. `curl .../check` matches the findings panel counts.
- [ ] **Step 6:** Commit `docs: running the live local server, pairing, the API`. Tell the owner to import channel board 2 into their own `.data`. Never do it in their data folder without asking.

## After this plan

Step 1 is done when the owner's bench tablet, paired once, shows a change made at the computer without reloading. Next is step 2 of the spec: accounts and sharing (public mode).
