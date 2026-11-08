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

`pnpm dev` sets it for you. A production build in public mode must have `NUXT_APP_SECRET` set before it starts. If only the file exists, the server refuses to start and names the command, `NUXT_APP_SECRET=$(cat <data>/session-secret)`; start the server with that variable set.

### First admin

A public server with no admin prints a setup code in its log, `[wirebender] setup code: …`. Sign in, then enter the code at `/setup`. You become admin and premium, and every board owned by the built-in Local user (your local-mode boards) moves to you, with its history. Each restart prints a new code until an admin exists; the old one stops working. After 5 wrong codes from one address, it is refused for 10 minutes.

### Admin page

`/admin` lists the accounts. Each has a premium switch and a suspend button. A suspended account cannot sign in, its share links stop working (`404`), and its open boards disconnect until it is unsuspended.

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

- `wirebender.sqlite`: all boards, their revision history and the paired devices.
- `backups/`: the server writes `pre-migration-<time>.sqlite` here before it changes the database layout.

Revisions are only ever added, never edited or deleted. To back up, stop the server and copy the whole data folder. To restore, put the folder back. Use `WIREBENDER_DATA=/some/folder pnpm dev` to keep experiments apart from your real boards.

One server per data folder: the server holds `<data>/wirebender.lock` while it runs, and a second server on the same folder refuses to start, naming the folder. So `PORT=3002 pnpm dev` without its own `WIREBENDER_DATA` will not start while another server uses `./.data`; give each server its own folder. A lock left by a server that crashed (its process is gone) is taken over.

## Pair a device

Requests from this computer (`localhost`) are trusted. Any other device must pair once:

1. On this computer, open a board and choose **Pair a device**. It shows a 6-digit code and a QR code.
2. On the tablet, open the address shown (`http://<LAN address>:<port>/pair`), enter the code and a name for the device. The code works once and expires after 10 minutes; after 5 wrong tries from one address it is refused for a while.
3. The tablet now lists the boards and edits live. Its edits are recorded as `Local · <device name>`.

**Paired devices** lists them; **Unpair** makes the device's next request fail with `401`.

## API

JSON over HTTP, for the app and for scripts (Claude reads and writes boards this way). In local mode callers must be trusted or paired; in public mode they must be signed in (a script cannot sign in yet; tokens come in step 3). A foreign `Origin` or `Host` is refused.

| Route | Does |
| --- | --- |
| `GET /api/boards?list=mine\|shared\|trash` | list your boards (`id`, `name`, `head`, `visibility`, ...; `mine` by default), those in the trash, or those shared with you (`key`, `name`, `owner`, `role`, `lastOpened`) |
| `POST /api/boards` | `{ "board": <board json> }` imports; `{ "name", "cols", "rows", "type" }` creates an empty board |
| `GET /api/boards/:id` | `{ id, name, head, board }`, plus `role` and `owner` for a share link |
| `PUT /api/boards/:id` | `{ "board": <board json>, "baseRevision"?: n }`; `409` with `{ current }` if `baseRevision` is not the head |
| `PATCH /api/boards/:id` | `{ "name" }` renames |
| `GET /api/boards/:id/check` | findings and counts, as in the findings panel |
| `GET /api/boards/:id/bench` | bench sheet (HTML) |
| `GET /api/boards/:id/download` | the board as a `.wirebender.json` file |
| `GET /api/boards/:id/thumbnail` | an SVG of the top side, for the board lists |
| `GET /api/boards/:id/revisions` | history; `POST /api/boards/:id/revisions/:n/restore` restores one |
| `GET /api/boards/:id/revisions/:n` | the board as it was at revision `n` |
| `POST /api/boards/:id/undo`, `/redo` | undo or redo the last change |
| `POST /api/pair/start` | this computer only: a new pairing code, `{ code, expiresAt, url }` |
| `POST /api/pair` | `{ "code", "name" }` pairs the calling device (the one call an unpaired device may make); sets its cookie |
| `GET /api/devices` | the paired devices (`id`, `name`, `createdAt`, `lastSeen`) |
| `DELETE /api/devices/:id` | unpairs a device |
| `GET /api/devices/me` | the calling device: `{ name, paired }` |

`:id` is a key: a board id (owner only) or a share link id. A role limits what a key can do: `PUT`, undo, redo and restore need edit; rename, trash, sharing and the link need the owner.

Every API write is its own revision (`how: api`) and shows live in open tabs. Writes from this computer (loopback, e.g. `curl` or Claude) are recorded as `Local · This computer`; a paired device's as `Local · <device name>`.

To change a board safely while others may be editing it, `GET` it first and `PUT` with `"baseRevision"` set to the `head` from that `GET`. A `409` means someone changed it in between (live edits still being grouped count): read it again and redo the change.
