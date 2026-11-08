# Step 4: Hosting and safety — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WireBender can be self-hosted with `docker compose up`, never loses a board, and boards move between servers with their full history.

**Architecture:**
- **Bundles.** Encoding and decoding a board bundle (zip) is pure code in `core/bundle.ts`, so the server, the CLI and the browser share it.
- **Server routes.** Thin routes export and import bundles, and build download-all zips.
- **Backups.** A Nitro plugin runs the daily backups with better-sqlite3's online backup.
- **Format docs.** The `wirebender/1` docs live in `docs/format/`, with a JSON Schema generated from the zod schema and a drift test.
- **Docker.** A multi-stage Dockerfile runs the production build (`.output`) in public mode on a `/data` volume.

**Tech Stack:** Nuxt 4 / Nitro, better-sqlite3, drizzle, zod 4 (`z.toJSONSchema`), fflate (new dependency, pure JS zip), vitest, Docker via OrbStack (owner installs it), Caddy (docs only).

**Spec:** `docs/superpowers/specs/2026-11-06-wirebender-service-design.md`: §7 "A board's history travels with it", §8, §10, and §12 item 4.

**Owner's calls for this step (2026-11-08):**
- Docker is checked locally with OrbStack.
- Where the owner's copy is hosted is decided later. This step documents a generic VPS + Caddy setup, and the deploy is a separate session.

## Global Constraints

**Bundles**
- The bundle file name is `<board name>.wirebender.zip`, and the media type is `application/zip`.
- A bundle holds the current `wirebender/1` file plus **every revision**. Each revision carries its time, how it was made, and its author's display name.
- Importing a bundle creates a board with that whole history. "Imported authors keep their names, marked 'imported'."
- Imported revisions never carry an account id (`author_id`) or a token id (`token_id`) from the other server.

**Download everything**
- "One button gives a zip of all your boards, each as a board bundle."
- "Each board also downloads on its own, as a plain file or a bundle."
- "The admin can download every board on the server."

**Backups**
- Daily. Use an online backup, not a file copy of a live database, into `<WIREBENDER_DATA>/backups/`.
- Keep the last **14**.
- Each new snapshot must open and pass `PRAGMA integrity_check` before any older one is removed.
- `pre-migration-*.sqlite` files are never pruned.

**Migrations**
- A backup runs before every database migration. This already exists in `server/db/index.ts`.
- Migrations only add.
- "A failed migration stops the server and leaves the database as it was."

**One data folder**
- `WIREBENDER_DATA` holds the database, the backups and the setup state.
- The default is `./.data` locally and the `/data` volume in Docker.

**Docker**
- The Nuxt server (Node) with SQLite on a volume. The image sets `WIREBENDER_MODE=public`.
- `docker compose up` with a short `.env` (public URL, OAuth ids and secrets, `NUXT_APP_SECRET`) is the whole self-host story, documented in the README.
- HTTPS is the host's or a reverse proxy's job. The docs show one Caddy example.

**Format docs**
- A spec page, a generated JSON Schema, example boards, and rules for future versions.
- Future versions: new fields are additive; breaking changes bump to `wirebender/2`, and old boards are converted when read, with the original kept.
- `revision` in a file is informational: a download writes the current revision there, and an import ignores it. A caller that wants "refuse if the board changed" sends `baseRevision` as a separate request field.

**Project rules**
- `core/` has no Node, Vue, Nuxt or DOM dependencies. fflate is pure JS, so it is allowed in `core/`.
- `pnpm test`, `pnpm typecheck` and `pnpm lint` must be clean before every commit.
- Never use ports 3000–3002 or the owner's `.data` folder. Use 3003 or higher, with a scratch `WIREBENDER_DATA`.
- Tokens: bundle import and export behave like the plain routes, and the existing deny-list is unchanged. Admin export stays under `/api/admin/*`, which is already denied to tokens.

## Review Focus

1. **A hostile or broken bundle.** This covers a zip bomb, a huge entry, missing `board.wirebender.json`, non-JSON, or a revision that fails `parseBoard`. Expected: 413 or 422 with a clear message, and nothing created. The tests belong to Task 1 (core) and Task 2 (route).
2. **A bundle whose history has gaps, or whose undo/redo targets are out of range.** Expected: the import renumbers the revisions 1..N in order and remaps each target, and any target that has no revision becomes `null`. Undo and redo on the imported board then work. The tests belong to Task 2.
3. **A bundle from a future version.** That is a `format` other than `wirebender-bundle/1`, or a board `format` other than `wirebender/1`. Expected: 422 `unsupported bundle format <x>`. The tests belong to Task 1.
4. **A backup run that fails.** This covers a full disk, a write error, or a snapshot that fails the integrity check. Expected: the server keeps running, the error is logged once, the bad snapshot is deleted, and older snapshots are untouched. The tests belong to Task 4.
5. **Production build differences** (native better-sqlite3, the migrations folder, WebSockets under the node preset). Expected: in the container, live editing between two browsers works and migrations run on an empty `/data`. The check belongs to Task 6, and it is a manual check.

---

### Task 1: Board bundles in core

**Files:**
- Create: `core/bundle.ts`
- Modify: `core/index.ts`, `package.json` (add `fflate`, latest 0.x)
- Test: `tests/core/bundle.test.ts`

**Interfaces:**
- Produces:
  - `BUNDLE_FORMAT = 'wirebender-bundle/1'`.
  - `MAX_BUNDLE_BYTES = 50_000_000` for the zip, `MAX_BUNDLE_UNZIPPED = 200_000_000`, and `MAX_BUNDLE_REVISIONS = 20_000`.
  - `interface BundleRevision { n: number, createdAt: number, author: string, how: string, target: number | null, summary: string, board: BoardFile }`
  - `interface Bundle { name: string, exportedAt: number, board: BoardFile, revisions: BundleRevision[] }`
  - `encodeBundle(b: Bundle): Uint8Array`
  - `decodeBundle(zip: Uint8Array): { ok: true, bundle: Bundle } | { ok: false, status: 413 | 422, error: string }`
- Zip layout:
  - `manifest.json`: `{ format, name, exportedAt, revisions: <count> }`
  - `board.wirebender.json`: the current board, formatted like the download route
  - `revisions/<n zero-padded to 6>.json`: `{ n, createdAt, author, how, target, summary, board }`
- Unzip with fflate's `unzipSync` and a `filter` that refuses an entry before inflating it. Refuse when an entry's `originalSize` exceeds `MAX_BOARD_BYTES` (2 000 000, the same cap as the server; pass it in as a parameter, `decodeBundle(zip, { maxBoardBytes })`), or when the sum of `originalSize` exceeds `MAX_BUNDLE_UNZIPPED`.

- [ ] **Step 1: Failing tests:**
  - `encode then decode round-trips channel board 2 with 3 revisions`
  - `a bundle with a revision that fails parseBoard is 422 naming the revision`, with the error starting `revisions/000002.json:`
  - `missing board.wirebender.json is 422 "bundle has no board.wirebender.json"`
  - `an unknown manifest format is 422 "unsupported bundle format wirebender-bundle/2"` (Review Focus 3)
  - `a zip over MAX_BUNDLE_BYTES is 413`
  - `an entry whose uncompressed size is over the board cap is 413 without inflating it`. Build a zip with a 3 MB entry of zeros (Review Focus 1).
  - `non-zip bytes are 422 "not a zip file"`
  - `more than MAX_BUNDLE_REVISIONS revisions is 413`
- [ ] **Step 2:** Run `pnpm vitest run tests/core/bundle.test.ts` and confirm the tests fail.
- [ ] **Step 3:** Implement. Revisions are sorted by `n` on decode. Errors name the entry. Board validation uses `parseBoard` from `core/schema`.
- [ ] **Step 4:** Run the tests until they pass, then run the full suite clean.
- [ ] **Step 5:** Commit `feat(core): board bundles with full history`.

### Task 2: Bundle export and import, and download-all on the server

**Files:**
- Create:
  - `server/api/boards/[id]/bundle.get.ts`
  - `server/api/boards/import-bundle.post.ts`
  - `server/api/me/export.get.ts`
  - `server/api/admin/export.get.ts`
  - `server/utils/bundles.ts`
- Modify:
  - `server/db/schema.ts`: add `revisions.imported integer not null default 0`
  - a new migration via `pnpm db:generate`
  - `server/utils/boards.ts`: `RevisionInfo.imported: boolean`
  - `server/utils/access.ts`: only if a new route needs a gate entry
- Test: `tests/server/bundles.test.ts`

**Interfaces:**
- Consumes: `encodeBundle` and `decodeBundle` (Task 1); `withAccess`, `withOwner` and `createBoard` from the existing utils.
- Produces:
  - `exportBundle(db, req: BoardRequest): ApiResult`, which needs view access. The body is the zip bytes, with `Content-Disposition: attachment; filename="<name>.wirebender.zip"`.
  - `importBundle(db, bytes: Uint8Array, who: Who): ApiResult`, which returns 201 `{ id, name, head, revisions: <count> }` and creates a board owned by the caller.
  - `exportAll(db, ownerId): Uint8Array`, a zip of `<name>.wirebender.zip` entries. Duplicate names get ` (2)`, ` (3)`. Trashed boards are left out.
  - `exportServer(db): Uint8Array`, for the admin: every board of every account, as entries `<owner name>/<board name>.wirebender.zip`.
  - `RevisionInfo.imported`, which the history panel uses in Task 3.
- **Import rules:**
  - Revisions are renumbered 1..N in bundle order. Each `target` is remapped through the old→new map, and a target with no match becomes `null`.
  - `author` is kept and `imported = 1`. `author_id` and `token_id` are `null`.
  - `how` is kept when it is in `REVISION_HOW`, and is otherwise stored as `'import'`.
  - Then one more revision, `how: 'import'`, by the caller, makes `bundle.board` the current board. The summary is `imported bundle (<count> revisions)`.
  - It all runs in one transaction.
- **Route body:**
  - The import route reads the raw body with the existing `readCapped`, capped at `MAX_BUNDLE_BYTES`. It accepts `Content-Type: application/zip` and `application/octet-stream`; anything else gets 415 `send the bundle as application/zip`.
  - `/api/me/export` serves `wirebender-boards-<YYYY-MM-DD>.zip`. In local mode it covers the local owner's boards.

- [ ] **Step 1: Failing tests:**
  - `bundle export then import recreates the board with every revision, authors marked imported`
  - `import renumbers revisions and remaps undo targets; a missing target becomes null`, with a bundle whose revisions are numbered 3, 7 and 9 and whose undo targets 7 and 4 (Review Focus 2)
  - `undo and redo work on an imported board`
  - `imported revisions carry no author_id or token_id`
  - `a bad bundle creates nothing`, where the board count stays the same after 422 and 413 (Review Focus 1)
  - `export needs view access; an edit link can export, a stranger gets 404`
  - `download-all holds one bundle per board, excluding trash, with duplicate names numbered`
  - `admin export holds every account's boards; a non-admin gets 403`
  - `a token can export and import a bundle`
  - `the migration only adds a column`, asserting the generated SQL has no DROP or a table rebuild
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests until they pass, then run the full suite clean.
- [ ] **Step 5:** Commit `feat(server): board bundles, download-all and admin export`.

### Task 3: Bundles in the app and the CLI

**Files:**
- Modify:
  - the board list page and its import control (`app/pages/index.vue` or wherever import lives today; grep for `import`)
  - the board page's download menu
  - `app/pages/account.vue`: "Download all my boards"
  - the admin page: "Download every board"
  - the history panel component: show the author followed by `(imported)` when `imported`
  - `cli/commands.ts`: `import` accepts `.wirebender.zip`; `pull --bundle` writes a bundle
  - `README.md`
- Test: `tests/cli/importPull.test.ts` (add cases). There are no component tests.

**Interfaces:**
- Consumes: the Task 2 routes.
- **App:**
  - Import on the board list accepts `.wirebender.json` and `.wirebender.zip`, and a zip goes to `import-bundle`.
  - The board download menu has two entries: **Board file** (the current download) and **Board with history** (bundle).
- **CLI:**
  - `wirebender import <file>`: a file ending `.zip` is sent as a bundle, after a local `decodeBundle` so a bad file exits 2 with no round trip. It prints `imported <name> (<n> revisions) → <url>/b/<id>`.
  - `wirebender pull <board> -o <file> --bundle`: the default file name ends in `.wirebender.zip`, and the `--force` rule is unchanged.

- [ ] **Step 1: Failing CLI tests:**
  - `import of a bundle prints the revision count`
  - `import of a bad bundle exits 2 without calling the server`
  - `pull --bundle writes the zip bytes`
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement the app and the CLI.
- [ ] **Step 4:** Browser check on a scratch local server on port 3003:
  - download a board with history, then import it back;
  - the history shows `(imported)` authors;
  - undo works;
  - download-all gives a zip of bundles.
- [ ] **Step 5:** README: "Moving a board between servers (with history)", "Download everything", and the CLI flags.
- [ ] **Step 6:** Run the full suite, typecheck and lint clean, then commit `feat(app): download and import boards with history`.

### Task 4: Daily backups and safe migrations

**Files:**
- Create: `server/utils/backups.ts`, `server/plugins/backups.ts`
- Modify: `README.md` (Backups section)
- Test: `tests/server/backups.test.ts`, `tests/server/migrations.test.ts`

**Interfaces:**
- Produces:
  - `BACKUP_KEEP = 14`
  - `BACKUP_EVERY_MS = 24 * 3600_000`
  - `runBackup(sqlite: Database.Database, dataDir: string, now = Date.now()): Promise<{ ok: true, file: string } | { ok: false, error: string }>`
    - Writes `backups/daily-<ISO stamp with : replaced by ->.sqlite` with `sqlite.backup(file)`, the online backup API.
    - Opens the snapshot read-only and requires `PRAGMA integrity_check` to return `ok`.
    - Only then prunes `daily-*.sqlite` down to the newest 14. It never touches other files.
    - On failure it deletes the partial or bad snapshot and returns the error. It never throws.
  - `backupDue(dataDir, now): boolean`: true when there is no `daily-*` file newer than 24 h.
- **Plugin:**
  - On start, if `backupDue`, it runs `runBackup`.
  - It then checks every hour and runs a backup when one is due.
  - It logs `backup written <file>` or `backup failed: <error>`. Repeated failures are logged once per day.
  - It stops its timer on Nitro close.
  - It is skipped when `process.env.VITEST`.

- [ ] **Step 1: Failing tests:**
  - `runBackup writes a snapshot that opens and passes integrity_check`
  - `a backup taken during writes holds a consistent database`: write rows in a loop while the backup runs, and the snapshot passes the check
  - `pruning keeps the newest 14 daily snapshots and never a pre-migration file`, with 16 daily files plus 1 pre-migration file
  - `a failed snapshot is deleted and older snapshots are kept`: make the backups folder read-only, or inject a failing integrity check through a parameter (Review Focus 4)
  - `backupDue is false within 24 h of the last daily snapshot`
  - in `migrations.test.ts`, `a failing migration throws and leaves the database as it was`: copy the migrations to a temp dir, add a broken `0099_bad.sql` with a journal entry, `openDb` throws, the tables and rows are unchanged, and a pre-migration backup exists
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
  - If the migration test shows drizzle does not roll back a failed migration, wrap `migrate` in a transaction in `openDb`.
  - Expose the raw sqlite handle to the plugin through `useDb().$client`.
- [ ] **Step 4:** Run the tests until they pass, then run the full suite clean.
- [ ] **Step 5:** README Backups section:
  - where the backups are and how many are kept;
  - how to copy them off the machine, with an `rsync` example and a `docker cp` example;
  - how to restore: stop the server, then copy a snapshot to `wirebender.sqlite`.
- [ ] **Step 6:** Commit `feat(server): daily online backups, 14 kept, checked before pruning`.

### Task 5: The `wirebender/1` format docs

**Files:**
- Create:
  - `docs/format/wirebender-1.md`
  - `docs/format/wirebender-1.schema.json` (generated)
  - `docs/format/examples/minimal.wirebender.json`
  - `docs/format/examples/channel-board-2.wirebender.json` (a copy of `data/channel-board-2.wirebender.json`)
  - `cli/schema.ts`
- Modify: `core/schema.ts` (export `boardFileSchema` if it isn't exported), `package.json` (add a `schema` script: `tsx --tsconfig tsconfig.cli.json cli/schema.ts`), `README.md` (link), `app/pages/api.vue` (link)
- Test: `tests/core/formatDocs.test.ts`

**Interfaces:**
- Produces:
  - `pnpm schema` writes `docs/format/wirebender-1.schema.json` from `z.toJSONSchema(boardFileSchema)`, adding `title: "WireBender board, wirebender/1"` (no `$id`: there is no public URL for it yet). It writes 2-space JSON with a trailing newline.
  - If `z.toJSONSchema` can't represent part of the schema (refinements, transforms), the page lists those rules in prose under "Rules the schema can't express".
- **The spec page covers:**
  - every field, with its type and meaning;
  - units and coordinates;
  - sides;
  - `revision` is informational (copy the Global Constraints line);
  - the bundle format (`wirebender-bundle/1`, from Task 1's layout);
  - "Rules for future versions" (copy the Global Constraints line, plus: readers must reject an unknown `format`);
  - links to the schema and the examples.
  - Write it from `core/schema.ts`, grepping every field.

- [ ] **Step 1: Failing tests:**
  - `the committed JSON Schema matches the generated one`: the drift test, whose failure message tells you to run `pnpm schema`
  - `every example board passes parseBoard`
  - `the spec page names every top-level field of the schema`: every key of the schema's top-level `properties` appears in the page in backticks
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Write `cli/schema.ts`, the examples and the page, then run `pnpm schema`.
- [ ] **Step 4:** Run the tests until they pass, then run the full suite clean.
- [ ] **Step 5:** Commit `docs(format): wirebender/1 spec page, JSON Schema and examples`.

### Task 6: The Docker image

**Files:**
- Create:
  - `Dockerfile`
  - `.dockerignore`
  - `compose.yaml`
  - `.env.example`
  - `server/api/health.get.ts`
- Modify:
  - `server/utils/access.ts`: let anonymous `GET /api/health` through the gate, if needed
  - `README.md`: a "Self-host with Docker" section, plus "HTTPS with Caddy" with one Caddyfile example
- Test: `tests/server/health.test.ts`. The image itself is checked by hand, in Step 4.

**Interfaces:**
- **`GET /api/health`:** returns `{ ok: true, mode }` in both modes, with no sign-in needed. It also runs `SELECT 1` on the database, and returns 503 `{ ok: false }` when that fails.
- **Dockerfile:**
  - The build stage is `node:24-slim`. It enables pnpm through corepack, runs `pnpm install --frozen-lockfile`, then `pnpm build`.
  - The run stage is `node:24-slim`. It copies `.output` and `server/db/migrations` to `/app/server/db/migrations`; check that `defaultMigrationsDir()` in `server/db/index.ts` finds them from `/app`. It sets `ENV WIREBENDER_MODE=public WIREBENDER_DATA=/data PORT=3000 NODE_ENV=production`, declares `VOLUME /data`, `EXPOSE 3000`, and a `HEALTHCHECK` that curls or wgets `/api/health`. If slim has neither tool, use a `node -e` fetch. It runs as a non-root user, and the start command is `node .output/server/index.mjs`.
  - better-sqlite3 must load in the run stage. If the native build needs toolchain packages, install them in the build stage and copy `node_modules` from it, or rely on Nitro's traced `.output/server/node_modules`.
- **compose.yaml:** one service `wirebender`, `build: .`, `env_file: .env`, port `3000:3000`, a named volume `wirebender-data:/data`, and `restart: unless-stopped`.
- **.env.example:** `WIREBENDER_URL`, `NUXT_APP_SECRET` (with a comment: `openssl rand -hex 32`), and the GitHub and Google pairs, all with placeholder values that are clearly fake.

- [ ] **Step 1: Failing test:**
  - `GET /api/health is 200 {ok:true, mode} without sign-in in public mode`
- [ ] **Step 2:** Implement the route and confirm the test passes.
- [ ] **Step 3: Production build without Docker:**
  - Run `pnpm build`.
  - Start it in public mode on port 3003 with a scratch data folder and dummy OAuth values. Set `NUXT_APP_SECRET` to a random value and `WIREBENDER_URL=http://localhost:3003`.
  - Check that `/api/health` is ok, that migrations ran on the empty folder, and that the board page opens (Review Focus 5).
  - Stop it by PID.
- [ ] **Step 4: The image.** This needs OrbStack; if `docker` is missing, report BLOCKED with this step undone.
  - Run `docker build -t wirebender .`.
  - Run `docker compose up` with a scratch `.env` (never commit it; it is ignored) mapped to host port 3003. Use `ports: "3003:3000"` through a compose override or `-p`.
  - Check that `/api/health` responds.
  - Stop the container.
  - Report the image size.
- [ ] **Step 5:** Write the README sections:
  - `cp .env.example .env`;
  - fill in the values;
  - `docker compose up -d`;
  - the OAuth callback URLs;
  - backups live in the volume;
  - how to upgrade: `git pull && docker compose up -d --build`, noting that a backup runs before migrations;
  - the Caddy example: `wire.example.org { reverse_proxy localhost:3000 }`, noting that WebSockets pass through.
- [ ] **Step 6:** Run the full suite, typecheck and lint clean, then commit `feat(docker): a self-host image and compose file`.

### Task 7: End to end with the owner

**Files:** none, unless the check finds a bug.

- [ ] **Step 1:** The controller runs the image on port 3003 with a scratch volume, a GitHub OAuth app callback, and the owner signing in. If the owner's existing OAuth app can't take a second callback, run with a `.env` whose `WIREBENDER_URL` matches a callback the owner adds.
- [ ] **Step 2:** The owner downloads a board with history from 3001, imports it into the container, and sees its history, with `(imported)` authors and working undo.
- [ ] **Step 3:** Two browsers edit the same board in the container, and the changes show live.
- [ ] **Step 4:** `docker compose restart`. The board and the backups survive, and a daily backup file exists in the volume.

## After this plan

- Step 4 is done when a board moves from the owner's local copy into a container with its full history, and the container keeps daily backups.
- **Still open:** the deploy of the owner's hosted copy, once the owner picks a host (spec §10). It is a short session: the host, a domain, the OAuth callback, `.env`, and the first sign-in, which claims admin with the setup code.
