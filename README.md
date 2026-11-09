# WireBender

WireBender is a local Nuxt app for planning hand-soldered perfboards: you draw wires and parts on a hole grid, and it checks the wiring with the same engine in the browser and on the command line. Findings are advisory only: check the board with a meter before powering it.

## Run it

```sh
pnpm install
pnpm dev                # http://localhost:3000
WIREBENDER_DATA=/tmp/wb PORT=3002 pnpm dev   # a second server: its own port and data folder
```

`pnpm dev` runs in local mode and listens on the network (`--host`), so a tablet on the same Wi-Fi can open `http://<this computer's LAN address>:<port>`. Open the board list, import a `.wirebender.json` file or start a new board. Boards are live: every open copy updates as you edit, and a copy that loses the server goes read-only (`Reconnecting… editing is paused`) until it is back.

Check a board file from the terminal with `pnpm check path/to/board.wirebender.json`.

Dev-mode exposure: because of `--host`, the dev server shows the project source to anyone on your LAN. Board data files are blocked. Run it on networks you trust.

`WIREBENDER_BOARD` is gone: the app no longer reads or writes a board file. Boards live in the server's database; import and export files from the board list (or `GET /api/boards/:id/download`).

## Modes

WireBender runs in one of two modes, set by `WIREBENDER_MODE`:

- `local` (`pnpm dev`): you, on your computer and your paired devices. No accounts. This is everything above.
- `public` (`pnpm dev:public`): a server other people sign in to, with GitHub or Google. Loopback and paired devices are not trusted there, and the pairing routes answer `404`.

Any other value stops the server with `WIREBENDER_MODE must be local or public`.

## Public mode

Set these before you start:

| Variable | Meaning |
| --- | --- |
| `WIREBENDER_URL` | the address people use to reach this server, e.g. `https://wire.example.org`. Without it the server stops: `public mode needs WIREBENDER_URL, the address people use to reach this server` |
| `WIREBENDER_DATA` | the data folder, as above |
| `NUXT_OAUTH_GITHUB_CLIENT_ID`, `NUXT_OAUTH_GITHUB_CLIENT_SECRET` | the GitHub sign-in |
| `NUXT_OAUTH_GOOGLE_CLIENT_ID`, `NUXT_OAUTH_GOOGLE_CLIENT_SECRET` | the Google sign-in |

You need at least one provider pair, or the server stops: `public mode needs a sign-in provider: set NUXT_OAUTH_GITHUB_CLIENT_ID and NUXT_OAUTH_GITHUB_CLIENT_SECRET, or the Google pair`.

**Register the OAuth app** with each provider:

- GitHub: create an OAuth app. Homepage URL is `WIREBENDER_URL`; callback URL is `<WIREBENDER_URL>/auth/github`.
- Google: create an OAuth client (web application). Redirect URI is `<WIREBENDER_URL>/auth/google`.

**Never commit the client id or secret.** Keep them in a file outside the repo, or in an untracked env file (`.env` and `.env-*` are ignored by the repo). Then pass the file in:

```sh
# ~/wirebender.env
WIREBENDER_URL=https://wire.example.org
NUXT_OAUTH_GITHUB_CLIENT_ID=<your client id>
NUXT_OAUTH_GITHUB_CLIENT_SECRET=<your client secret>
```

```sh
pnpm dev:public --dotenv ~/wirebender.env
```

**Use https in a real deployment.** The session cookie is `Secure` only when `WIREBENDER_URL` is https (in local mode: when the request came over TLS). `NUXT_SESSION_COOKIE_SECURE` overrides this. If `WIREBENDER_URL` is `http://` on an address other than loopback, the server logs a warning at start, because anyone on the network path can read the cookie.

**Session secret.** Sessions are sealed with a secret, taken from the first of these that is set:

1. `NUXT_APP_SECRET`
2. `NUXT_SESSION_PASSWORD`
3. the file `<data>/session-secret`, which the server creates once (random, readable only by you)

`pnpm dev:public` sets it for you: before the server starts, it copies the first of these into `NUXT_APP_SECRET`, which is what nuxt-auth-utils seals sessions with. (`pnpm dev` is local mode, which has no sessions and needs no secret.) A production build in public mode must have `NUXT_APP_SECRET` set before it starts; nothing copies it there. If only `NUXT_SESSION_PASSWORD` or the file is set, the server refuses to start and names the fix, `NUXT_APP_SECRET="$NUXT_SESSION_PASSWORD"` or `NUXT_APP_SECRET=$(cat <data>/session-secret)`; start the server with that variable set.

Whenever `NUXT_SESSION_PASSWORD` is set, nuxt-auth-utils logs that it "is not used anymore" and to set `NUXT_APP_SECRET` instead. Under `pnpm dev:public` this is harmless, because WireBender has copied it into `NUXT_APP_SECRET`. In a production build, set `NUXT_APP_SECRET` as the start-up message says.

### First admin

A public server with no admin prints a setup code in its log, `[wirebender] setup code: …`. Sign in, then enter the code at `/setup`. You become admin and premium, and every board owned by the built-in Local user (your local-mode boards) moves to you, with its history. Each restart prints a new code until an admin exists; the old one stops working. After 5 wrong codes from one address, it is refused for 10 minutes.

### Admin page

`/admin` lists the accounts. Each has a premium switch, an admin switch and a suspend button. A suspended account cannot sign in, its share links stop working (`404`), and its open boards disconnect until it is unsuspended.

The admin switch makes another account an admin, with the same powers as you. The server always keeps one active (not deleted, not suspended) admin: the only admin can neither turn off their own admin switch nor delete their account, and is told `You are the only admin. Make another account admin first.` Turn on someone else's admin switch first.

## Sharing

Every board has a share link, `<WIREBENDER_URL>/b/<link id>`. The owner chooses who it admits with **Share**:

- **View**: anyone with the link can look (both sides, 3D, findings, bench sheet, download).
- **Edit**: signed-in visitors can edit live. A signed-out visitor can look, but must sign in to edit.
- **Private**: the link is off. Only the owner sees the board.

An optional link password is asked once per session. Private and passwords need premium (`Premium is needed for private boards and link passwords.`). Losing premium keeps what is set; lowering visibility or removing a password is always allowed.

Changing the settings disconnects everyone who joined by link; they reconnect and are checked again. **New link** gives the board a new link, and the old one stops working.

Boards opened by someone else's link are listed under **Shared with me**. A signed-in visitor can **Fork** a shared board into their own account, and the owner can **Duplicate** a board.

## Trash, deletion and limits

- Deleting a board moves it to the trash. After 30 days it is purged, with its history. **Restore** brings it back before that.
- **Delete for good** works only from the trash, and you must type the board's exact name.
- Deleting your account starts a 30-day wait. Sign in again within 30 days and choose **Restore** on `/account` to keep it. After that the account and its boards are purged.
- Limits, for signed-in accounts in public mode: 200 boards (not counting the trash) for free accounts, 2000 for premium, and 30 creates, imports or forks per minute. Local mode has no limits.

## Data and backups

Everything is stored in `WIREBENDER_DATA` (default `./.data`, which git ignores):

- `wirebender.sqlite`: all boards, their revision history, the accounts and the paired devices.
- `backups/`: `pre-migration-<time>.sqlite` is written here before the server changes the database layout (a migration that fails is rolled back and the server refuses to start). `daily-<time>.sqlite` is an online snapshot taken at start and then once a day while the server runs, checked with `PRAGMA integrity_check` before older ones are pruned. The newest 14 daily snapshots are kept; `pre-migration-*` files are never pruned.
- `session-secret`: public mode only, made once when no `NUXT_APP_SECRET` or `NUXT_SESSION_PASSWORD` is set. Anyone who has it can forge a session as any account: keep it private, including in your backups.

Revisions are never edited. They are deleted only with their board: when the trash is purged (30 days after the board was trashed, or with a purged account), or by **Delete for good**. To back up, stop the server and copy the whole data folder. To restore, put the folder back. Use `WIREBENDER_DATA=/some/folder pnpm dev` to keep experiments apart from your real boards.

One server per data folder: the server holds `<data>/wirebender.lock` while it runs, and a second server on the same folder refuses to start, naming the folder. So `PORT=3002 pnpm dev` without its own `WIREBENDER_DATA` will not start while another server uses `./.data`; give each server its own folder. A lock left by a server that crashed (its process is gone) is taken over.

### Backups

Daily snapshots are in `<WIREBENDER_DATA>/backups/`, 14 kept. They live on the same disk as the database, so copy them off the machine:

```sh
rsync -a --include='daily-*.sqlite' --exclude='*' you@server:/path/to/data/backups/ ./wirebender-backups/
docker cp wirebender:/data/backups ./wirebender-backups
```

(Use your own data folder and container name.) The snapshots hold the accounts too, so keep the copies private.

To restore, stop the server, then copy a snapshot over the database and delete the old `-wal` and `-shm` files beside it:

```sh
cp backups/daily-2026-11-09T03-00-00.000Z.sqlite wirebender.sqlite
rm -f wirebender.sqlite-wal wirebender.sqlite-shm
```

### Moving a board between servers (with history)

On the board list, a board's menu has **Board file** (the current board only) and **Board with history** (a `.wirebender.zip` holding every revision). On the other server, **Import** accepts either file; a zip creates a new board with its history. Revisions that came from a zip show `(imported)` after the author in the History tab: the author is a name only, and Undo works across them. From a script: `GET /api/boards/:id/bundle` and `POST /api/boards/import-bundle` (raw zip body, `Content-Type: application/zip`), or the CLI below.

### Download everything

The Account page has **Download all my boards**: one zip with a bundle per board (not the trashed ones). It is rate limited (6 a minute; the app shows a message when you hit it). The admin page has **Download every board**, a server-wide zip that includes trashed boards.

## Pair a device

Requests from this computer (`localhost`) are trusted. Any other device must pair once:

1. On this computer, open a board and choose **Pair a device**. It shows a 6-digit code and a QR code.
2. On the tablet, open the address shown (`http://<LAN address>:<port>/pair`), enter the code and a name for the device. The code works once and expires after 10 minutes; after 5 wrong tries from one address it is refused for a while.
3. The tablet now lists the boards and edits live. Its edits are recorded as `Local · <device name>`.

**Paired devices** lists them; **Unpair** makes the device's next request fail with `401`.

## API

JSON over HTTP, for the app and for scripts (Claude reads and writes boards this way). In local mode callers must be trusted or paired; in public mode they must be signed in (a script signs in with a token, see Tokens). A foreign `Origin` or `Host` is refused.

| Route | Does |
| --- | --- |
| `GET /api/boards?list=mine\|shared\|trash` | list your boards (`id`, `name`, `head`, `visibility`, `hasPassword`, ...; `mine` by default), those in the trash, or those shared with you (`key`, `name`, `owner`, `role`, `lastOpened`) |
| `POST /api/boards` | `{ "board": <board json> }` imports; `{ "name", "cols", "rows", "type" }` creates an empty board; answers `{ id }` |
| `GET /api/boards/:id` | `{ id, name, head, board, role, signInToEdit, owner: { name }, forkedFrom }`. `id` is the key you asked with; `role` is `owner`, `edit` or `view`; `signInToEdit` is true for a signed-out visitor on an edit link; `forkedFrom` is `{ key, name }` of the board this one was forked from, for its owner while they can still open that board by the link they forked it through, else `null` |
| `PUT /api/boards/:id` | `{ "board": <board json>, "baseRevision"?: n }`; `409` with `{ current }` if `baseRevision` is not the head. Only the owner's PUT can change the name; anyone else's keeps it |
| `PATCH /api/boards/:id` | `{ "name" }` renames (owner) |
| `DELETE /api/boards/:id` | `{ "confirm": <the board's exact name> }` deletes a board in the trash for good, with its history (owner) |
| `GET /api/boards/:id/check` | findings and counts, as in the findings panel |
| `GET /api/boards/:id/bench` | bench sheet (HTML); `?flip=lr` (default) or `tb` turns the bottom overviews over left-right or top-bottom, anything else is 422 |
| `GET /api/boards/:id/download` | the board as a `.wirebender.json` file |
| `GET /api/boards/:id/thumbnail` | an SVG of the top side, for the board lists |
| `GET /api/boards/:id/revisions` | history |
| `GET /api/boards/:id/revisions/:n` | the board as it was at revision `n` |
| `POST /api/boards/:id/revisions/:n/restore` | makes revision `n` the board again, as a new revision |
| `POST /api/boards/:id/undo` | undo the last change (`409` with `{ reason }` if there is nothing to undo) |
| `POST /api/boards/:id/redo` | redo the last undone change (`409` with `{ reason }` if there is nothing to redo) |
| `POST /api/boards/:id/fork` | a copy in your account, `{ id }` (signed in; on your own board it is a duplicate named `<name> (copy)`) |
| `POST /api/boards/:id/trash` | moves the board to the trash, `{ trashedAt }` (owner) |
| `POST /api/boards/:id/untrash` | brings it back, `{ trashedAt: null }` (owner) |
| `GET /api/boards/:id/sharing` | `{ visibility, hasPassword, link, canUsePremium }` (owner, public mode) |
| `PATCH /api/boards/:id/sharing` | `{ "visibility"?: "view"\|"edit"\|"private", "password"?: string\|null }`; answers like the GET (owner, public mode) |
| `POST /api/boards/:id/sharing/regenerate` | a new share link, `{ link }`; the old one stops working (owner, public mode) |
| `POST /api/links/:linkId/unlock` | `{ "password" }` opens a password link for this session (public mode; 5 wrong tries per address per 10 minutes, then `429`) |
| `GET /api/me` | `{ mode, user, providers }`: who is signed in (`id`, `name`, `avatar`, `isAdmin`, `isPremium`, `providers`, `deletedAt`), or `user: null` |
| `PATCH /api/me` | `{ "name" }` sets your display name (1 to 60 characters) |
| `DELETE /api/me` | deletes your account, restorable for 30 days, and signs you out (public mode; `409` for the only admin) |
| `POST /api/me/restore` | restores your deleted account after signing in again (public mode) |
| `POST /api/setup` | `{ "code" }` the setup code from the log, `{ ok, admin }` (public mode, until an admin exists; see First admin) |
| `GET /api/admin/users` | every account (`id`, `name`, `providers`, `boards`, `isPremium`, `isAdmin`, `suspendedAt`, `deletedAt`, ...) (admin) |
| `PATCH /api/admin/users/:id` | `{ "premium"?, "suspended"?, "admin"? }`, each `true` or `false`; any other key is `422` (admin) |
| `POST /api/pair/start` | this computer only: a new pairing code, `{ code, expiresAt, url }` (local mode) |
| `POST /api/pair` | `{ "code", "name" }` pairs the calling device (the one call an unpaired device may make); sets its cookie (local mode) |
| `GET /api/devices` | the paired devices (`id`, `name`, `createdAt`, `lastSeen`) (local mode) |
| `DELETE /api/devices/:id` | unpairs a device (local mode) |
| `GET /api/devices/me` | the calling device: `{ name, paired }` (local mode) |
| `GET /api/tokens` | your tokens (`id`, `name`, `prefix`, `createdAt`, `lastUsedAt`), never the token itself |
| `POST /api/tokens` | `{ "name" }` makes a token; answers `201 { id, name, prefix, token }`, the only time `token` is shown (up to 20 tokens) |
| `DELETE /api/tokens/:id` | revokes one of your tokens, `204` |

Sign-in starts at `/auth/github` or `/auth/google`, and `/_ws/board/:id` is the live board's WebSocket (y-websocket protocol; a message over 4,000,000 bytes, a presence update over 8 KB, or a change that makes the board larger than 2,000,000 bytes is refused; only the owner's changes may rename the board). In public mode nuxt-auth-utils also answers `GET` and `DELETE /api/_auth/session` (sign out); any other `/api` path is `404`.

`:id` is a key: a board id (owner only) or a share link id. A role limits what a key can do: `PUT`, undo, redo and restore need edit; rename, trash, sharing and the link need the owner.

Send a token as `Authorization: Bearer <token>`. Every API write is its own revision (`how: api`) and shows live in open tabs. Writes from this computer (loopback, e.g. `curl` or Claude) are recorded as `Local · This computer`; a paired device's as `Local · <device name>`; a token's as `<token name> · <user name>` (`<token name> · Local` in local mode).

To change a board safely while others may be editing it, `GET` it first and `PUT` with `"baseRevision"` set to the `head` from that `GET`. A `409` means someone changed it in between (live edits still being grouped count). `PUT` answers `{ current }`, the head now; undo, redo and restore answer `{ reason }`. Read the board again, redo the change on it, and send that with the new head; never retry the old body.

The app's `/api` page lists these routes and the errors.

The board file itself, and the bundle zip, are described in [docs/format/wirebender-1.md](docs/format/wirebender-1.md), with a [JSON Schema](docs/format/wirebender-1.schema.json) (regenerate it with `pnpm schema`) and [example boards](docs/format/examples/).

## Tokens

A token lets a script or an AI client use the API as you. Make one on `/account` (**Tokens**): give it a name, copy it at once, it is shown only that one time. A token starts with `wb_`; keep it private and never commit it. You can have 20. **Revoke** stops it at once, and closes its open live connections.

- In local mode a token can be made only on this computer, not from a paired device (`403`, `Create tokens on this computer.`): a token made on a tablet would outlive unpairing it. A paired device can still list and revoke tokens.
- Send it as `Authorization: Bearer <token>`. It acts as its owner, with that owner's access to boards and share links.
- In public mode a script needs a token. In local mode this computer is trusted, so a token is optional; with one, the change has a named author, `<token name> · Local`.
- While a token works on a board, open copies show it in the presence bar with a robot icon.
- History shows `<token name> · <user name>`. An undo or redo reads `undo of #N by <author>` (or `redo of ...`), naming the author of change `#N`.

A token cannot (`403`, `Not allowed with a token.`):

- manage tokens, or delete, restore or sign out of your account (`/api/me`);
- delete a board for good, change its sharing, or make a new share link;
- use `/api/admin`, `POST /api/setup`, `/auth/*` or `/api/_auth/*`;
- pair or manage devices (`/api/pair`, `/api/devices`);
- unlock a password link.

Do those in the app.

## CLI import and pull

Besides `check` and `export`, the CLI can talk to a running server:

```sh
pnpm wirebender import board.wirebender.json [--url http://localhost:3000] [--token wb_...]
pnpm wirebender pull <board> -o board.wirebender.json [--force] [--url ...] [--token ...]
pnpm wirebender import board.wirebender.zip      # a board with its history
pnpm wirebender pull <board> --bundle [-o board.wirebender.zip] [--force]
```

`--url` defaults to `$WIREBENDER_SERVER`, then `http://localhost:3000`; `--token` to `$WIREBENDER_TOKEN`. `import` checks the file, creates a board and prints its address. `pull` saves a board (an id or share link id) to a file; it will not replace an existing file without `--force`. A file ending `.zip` is a board bundle: `import` checks it locally (a bad one exits `2` without calling the server) and prints `imported <name> (<n> revisions) → <url>/b/<id>`. `pull --bundle` saves the board with its full history; `-o` defaults to `<board>.wirebender.zip`, and `--force` works as before. Exit codes: `0` done, `1` the server refused (its message is printed), `2` bad usage, a bad board file, or an existing output file.

## MCP server for Claude Code

`pnpm wirebender mcp` is an MCP server on stdio. Its tools are `list_boards`, `get_board`, `replace_board`, `check_board`, `list_revisions`, `get_revision`, `undo`, `redo`, `restore_revision` and `create_board`; they follow the editing rules under API (`get_board`, then `replace_board` with `baseRevision`).

Register it with Claude Code. Replace `wb_...` with your token, and `/path/to/wire-bender` with this folder (`--silent` is required, or pnpm's own output breaks the protocol):

```sh
claude mcp add wirebender --env WIREBENDER_SERVER=http://localhost:3000 --env WIREBENDER_TOKEN=wb_... -- pnpm --silent --dir /path/to/wire-bender wirebender mcp
```

For a server on another port or address, change `WIREBENDER_SERVER` (or add `--url <server>` after `mcp`; `--token <token>` works too). In local mode you can leave out `WIREBENDER_TOKEN`; in public mode it is required.
