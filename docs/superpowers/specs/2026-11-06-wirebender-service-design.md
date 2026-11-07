# WireBender as a service: design

Date: 2026-11-06 · Status: approved by the owner (2026-11-06) · Replaces milestone 4
("hosted static version") of `2026-11-05-wirebender-design.md`.

Everything in the 2026-11-05 design still holds (board model, check, editor, bench export,
3D view, anti-goals) except the parts listed in §11, which this document changes.

## 1. Intent

WireBender becomes an online service, in the spirit of codeshare but for perfboard
layouts: you sign in, keep your boards, and share a board with a link. It stays open
source, and anyone can run their own copy with one container. On the owner's machine
(localhost) it runs the same server, with no sign-in.

Who it is for (owner's words): **a maker sharing their perfboard layout with a friend, or
using it like the owner does to see a board on screen and print build instructions.**

### Why

- **Live editing across devices and people.** The owner's first wish: a board open on
  several devices at once (the computer, the tablet at the bench), where a change made at
  the computer shows up at the bench. The same mechanism lets a friend, or an AI,
  edit the same board at the same time.
- **Sharing.** Send a link; the friend looks, or forks a copy into their own account.
- **One way of doing things.** Today there are two paths (Claude edits the file on disk;
  the browser saves through the server, with file watching and a conflict banner). The
  owner chose a single path: **everything goes through the API**, the browser and the
  AI alike.

### What success looks like

- The owner works on channel board 2 at the computer and sees each change on the bench
  tablet within about a second, without reloading.
- Claude changes the board through the API (via MCP) while the owner watches it happen
  in the editor, and the owner can undo Claude's change like any other.
- A friend opens the owner's link, looks at both sides and in 3D, and forks it.
- Someone else runs their own copy with `docker compose up`.
- No board is ever lost.

## 2. Goals, non-goals, anti-goals

### Goals

- Accounts (GitHub or Google sign-in), a list of your boards, a share link per board.
- Live editing: every open copy of a board updates within ~1 s of a change.
- Every change is stored as a revision with its author; undo reverts the latest change on
  the board, whoever made it; a history you can browse and restore from.
- An API that does everything the editor can, with tokens for AI; an MCP server on top.
- Free accounts: all boards public. Premium accounts (a flag the admin sets, no payment):
  private boards and password-protected share links.
- One container, SQLite inside, that the owner hosts and anyone can self-host.
- The `wirebender/1` format documented as an open standard (carried over from the old
  milestone 4).

### Non-goals (for now)

- Payments, plans, billing. Premium is a database flag.
- Email of any kind: no email sign-in link, no notifications, no password reset (there
  are no passwords to reset, except share-link passwords, which the owner of the board sets).
- A public gallery or search of boards. Public means "anyone with the link can view".
- Comments, chat, or per-hole annotations.
- Teams or organisations; sharing a board with named accounts (sharing is by link only).
- A static, server-less build (the old milestone 4 plan; dropped).
- Postgres. SQLite only; moving later stays possible (Drizzle in between).

### Anti-goals (would make it a failure even if every feature works)

- **Losing a board.** The owner's words: starting to use it, liking it, and then losing
  all those designs. Every rule in §8 exists for this.
- Any change that silently replaces wiring someone drew, without a revision to go back to.
- An open copy silently showing an older version of a board than the server has.
- A token that can delete an account, delete a board for good, or widen who can see a board.
- A self-hosted copy that only works on one vendor's cloud.
- Two copies of the rule engine (still true: `core/` is the only one; the server and the
  browser both call it).

## 3. Modes: local and public

The same server runs in one of two modes.

- **Local mode** (the owner's machine, `pnpm dev`): **no sign-in**. There is one local
  user who owns every board, is admin and is premium. Requests from the machine itself
  (loopback) need no token, so Claude on the same machine can use the API directly.
  The server also listens on the home network, so other devices can reach it, but a
  device must be **paired** first (below).
- **Public mode** (a server others can reach, e.g. the Docker image): everyone signs in
  with GitHub or Google. Without sign-in you can only open public boards and links shared
  with you. Loopback is **not** trusted in public mode (behind a reverse proxy every
  visitor would look local).

The mode is **set explicitly** by `WIREBENDER_MODE=local|public`, never guessed from the
network: `pnpm dev` sets `local`, the Docker image sets `public`. Public mode refuses to
start without at least one sign-in provider configured.

### Pairing a device in local mode (owner's call: a pairing code)

The bench tablet (or a phone) gets in by pairing once:

- On the computer, the editor's "Pair a device" shows a short code and a QR code with the
  server's network address. The code is single-use and expires after 10 minutes.
- The device opens the address (or scans the QR) and enters the code. It is then trusted
  as the local user, with a long-lived cookie; it stays paired across restarts.
- "Paired devices" lists each device (name, last seen) with **Unpair**.
- Unpaired devices on the network get only the "enter pairing code" page. Wrong codes are
  rate-limited.

### Moving from local to public

A data folder first used in local mode can be run in public mode later. The person who
completes the setup code (below) becomes the admin and **takes over the local user's
boards**, with their history.

### First run in public mode: the setup code

On first start, a public server with no admin prints a **one-time setup code** in its log.
The admin page asks for it; whoever enters it and then signs in becomes the admin. The
code is single-use and stops working once an admin exists. (A password page on a fresh
public server could be claimed by whoever finds it first; reading the log needs access to
the server.)

The admin page lists accounts and lets the admin set or clear the **premium** flag and
suspend an account. Nothing else for now.

## 4. Accounts and boards

- **Sign-in:** GitHub OAuth and Google OAuth. A self-hoster registers their own OAuth
  app(s); either one is enough. One account can link both (same person signing in with
  either). No email sending anywhere.
- **Board list:** your boards, newest change first, with name, last change (when, by
  whom), visibility, and a thumbnail. New board (empty, with a size and one-/two-sided),
  import a `wirebender/1` file, open, rename, duplicate, fork (from someone else's board),
  move to trash.
- **Fork:** anyone signed in can fork a board they can view. The fork is a new board in
  their account, starting at the source's current state, with a "forked from" link back
  (the link shows only if the source is still viewable by them). History is not copied.
- **Trash:** a deleted board goes to the trash, restorable for 30 days, then is removed for
  good. Deleting an account works the same way: 30 days to change your mind, everything
  restorable until then.

## 5. Sharing

Each board has **one share link** with a random, unguessable id
(`/b/<uuid>`). The owner can **regenerate** it, which kills the old link.

What the link allows is the owner's choice:

| Setting | Who can open it | Free | Premium |
|---|---|---|---|
| **View** | anyone with the link (no sign-in needed) | yes | yes |
| **Edit** | anyone with the link, live; editing needs sign-in | yes | yes |
| **Password** (view or edit) | anyone with the link and the password | no | yes |
| **Private** | only the owner; the link does not open | no | yes |

- A free account's boards are always at least viewable by link.
- Anonymous visitors can view, see 3D and open the bench sheet. To edit or fork they sign in.
- Edits through a shared link are recorded under the editor's account.
- **What an edit link allows:** everything that makes a revision, so all of it can be
  undone: editing items, board and bench settings, undo and redo, restoring an old
  revision. **Not:** renaming, moving to the trash, sharing settings or the link itself.
  Those stay with the owner.
- A board opened through a link while signed in appears in that person's list under
  **Shared with me**, for as long as the link still works (regenerating the link or
  lowering it from edit to view takes effect immediately).
- A premium account that loses premium keeps its boards; private boards and passwords
  stay as they are, but new private boards and new passwords can't be added. (Never
  expose a board because of a billing-flag change.)

## 6. Live editing

### Technology (owner's request: the same as Nuxt UI's collaborative editor)

Nuxt UI's editor example does live editing with **Yjs** (a CRDT library that merges
everyone's changes) and relays changes through PartyKit, a hosted Cloudflare service.
WireBender uses **Yjs** too, but relays through **its own server**, over a WebSocket on
the Nuxt/Nitro server, so the single self-hosted container stays true (§2 anti-goal).
Presence (who is here) uses Yjs **awareness**, as in that example.

### How the board maps onto Yjs

The board is not edited as free text, and two people changing the same trail at once
must not produce a merged trail that no one drew. So each **item** of the board is one
whole value in a Yjs map, keyed by its id: each part, trail, wire, net, leg-fold and
solder bridge, plus the board settings and the bench settings as their own values.

- Two people editing **different** items: both changes land.
- Two people editing the **same** item at the same moment: one write wins for that item,
  the same one on every screen. The other change is still in the history.
- **Editing needs a live connection.** A copy that loses its connection shows a banner and
  goes read-only until it is back; it never queues edits to replay later. (An hour-old
  tablet replaying stale edits over everyone else's work would break the anti-goals.) The
  window for two writes to the same item is therefore only a network round trip.
- The editor keeps using `core/` edit functions on a plain `BoardFile`; a small binding
  layer (shared by the browser and the server, outside `core/`) turns a before/after
  pair into item writes, and the Yjs document back into a `BoardFile`.

### The server is a peer that keeps the record

- The server holds the Yjs document of every open board in memory, applies each update,
  and **checks that the result still parses as `wirebender/1`**. An update that would
  break the board is not accepted: the server writes the previous values back and tells
  that client why.
- The server turns changes into **revisions** (§7) and stores them in SQLite.
- When the last client leaves, the document is written out and dropped from memory.
- The API (§9) is just another writer: a `PUT` from an AI becomes item writes on the
  same document, so every open copy sees it live.

### What the editor shows

- Who else is on the board (avatars; an AI token shows as its name, e.g. "Claude").
- Connection state: live, or reconnecting (read-only).
- No conflict banner any more: there is no file on disk to disagree with.

## 7. Revisions, undo and history

**Every change is a revision**: who made it (account, account via token "Claude", or the
local user), when, how (editor tool, API, restore, undo), and the board after it.

- One user action is one revision: a pencil stroke from first click to end, one erase
  click, one joint toggle, one API call. Item writes from the same author within ~2 s are
  grouped into one revision (builder may tune).
- **Undo** (Ctrl/Cmd+Z, the button) reverts **the latest change on the board, whoever
  made it**, as a new revision ("undo of #42 by Claude"). **Redo** re-applies it. Undo and
  redo are shared: everyone on the board sees the same stack. (Owner's call: "undo it, like
  any other change" when the AI made a change you don't like.)
- **History panel:** a list of revisions (newest first) with author and a one-line summary
  ("pencil: T7 on bottom", "API: W5 moved to top"). Click one to see the board as it was
  (read-only preview, both sides, the check's counts). **Restore** makes that state the
  current board, as a new revision. Nothing is ever rewritten; history only grows.
- Revisions are kept for the board's life. How they are stored (full snapshots, Yjs
  updates with snapshots every N, compression) is the builder's call; a board is small
  (channel board 2 is ~50 kB as JSON).

### A board's history travels with it (owner's call: full history)

- **Board bundle**: a board can be exported as a bundle (a zip, `.wirebender.zip`) holding
  its current `wirebender/1` file plus **every revision**, each with its time, how it was
  made, and its author's display name. Importing a bundle on any WireBender server creates
  a board with that whole history (imported authors keep their names, marked "imported").
- This is how a board moves between the owner's local copy and the hosted one, and it is
  also the full-fidelity backup format (§8).
- The `revision` field in a `wirebender/1` file is informational: a download writes the
  board's current revision number there, an import ignores it. A caller that wants
  "refuse if the board changed" sends the base revision as a separate request field. The
  format docs say so.

## 8. Never losing a board

- **Nothing is overwritten**: every change is a new revision (§7), so any bad edit, from
  anyone, is one restore away.
- **Delete is soft**: trash for boards and accounts, 30 days (§4). A token can never
  empty the trash, delete for good, or delete an account.
- **Download everything**: one button gives a zip of all your boards, each as a board
  bundle (§7: current `wirebender/1` file plus full history). Each board also downloads on
  its own, as a plain file or a bundle. The admin can download every board on the server.
- **Automatic backups**: the server snapshots its SQLite database daily (online backup,
  not a file copy of a live database) into its data folder, keeps the last 14, and checks
  each new snapshot opens and passes an integrity check before removing older ones. The
  docs explain how to copy backups off the machine.
- **Upgrades never lose data**: a backup runs before every database migration; migrations
  only add (new tables, new columns); a failed migration stops the server and leaves the
  database as it was. A breaking change to the board format gets a new version
  (`wirebender/2`), and old boards are converted when read, with the original kept.
- **One data folder**: the database, backups and the setup state live in one folder
  (`WIREBENDER_DATA`, default `./.data` locally, a volume in Docker). Copying that folder
  is a full copy of the service.

## 9. API, tokens and MCP

### The API

One HTTP API, used by the editor, the CLI, scripts and AI alike. JSON, boards as
`wirebender/1`. At least:

- list boards; create; import a file; get a board; rename; fork; trash and restore;
- **replace a board** (`PUT` a whole `wirebender/1` board): becomes item writes, one
  revision, live for everyone. An optional base revision makes it refuse (409) when the
  board changed since, for callers who want that;
- run the check (findings as in the CLI); get the bench sheet (server-built HTML, as now);
- list revisions, get a revision's board, restore a revision, undo, redo;
- sharing settings, the share link, regenerate it (not with a token, see below);
- tokens: list, create, revoke (not with a token).

Exact routes, pagination and error shapes are the builder's call; they get documented on
a page in the app.

### Tokens

- Created by a signed-in user in their settings, with a name ("Claude on my laptop").
  Shown once; stored hashed; last-used time shown; revocable.
- A token acts **as its user**, with everything the user can do **except**: deleting the
  account, emptying the trash or deleting a board for good, creating or revoking tokens,
  and changing who can see a board (visibility, link setting, password, regenerating the
  link). Moving a board to the trash is allowed (it is recoverable).
- Revisions made with a token show the token's name.
- In local mode no token is needed from the machine itself; tokens still work.

### MCP server

A small MCP server (a separate command in this repo, e.g. `pnpm wirebender mcp`) so Claude
Code works on a board through the API as naturally as it edited the file before. It takes
the server URL and a token. Tools at least: list boards, read a board, replace a board,
run the check, list revisions, undo, restore. Each call is a normal API call (so it is
live and recorded).

### The CLI

Keeps `check` and `export` on files (they only need `core/`). Gains `import <file>` and
`pull <board> -o <file>` against a server (URL and token), so a board can still be
exported back into a hardware project's folder.

## 10. Hosting

- **One Docker image**: the Nuxt server (Node) with SQLite on a volume. `docker compose up`
  with a short `.env` (public URL, OAuth app ids and secrets) is the whole self-host story,
  documented in the README.
- The owner's own hosted copy runs that image on a small always-on machine; **where** is
  still open (a small VPS, Fly.io or Railway all fit; serverless hosts like Vercel or
  Netlify do not, because live editing needs a server that stays up and holds WebSockets).
- HTTPS is the host's or a reverse proxy's job; the docs show one Caddy example.

## 11. What this changes in the 2026-11-05 design

- §2 non-goal "a hosted version for other users …" and §11 item 4 (static site, board
  files never leave the machine, no accounts): **replaced** by this document.
- §1 workflow step 7 and §7 "Claude edits the board file directly": Claude works through
  the API / MCP instead. The CLI still checks and exports files.
- §5 "Saving: edits are written back to the board file … the open page reloads it" and
  §9b "Conflicts" (file changed on disk): **replaced** by live editing (§6) and revisions
  (§7). The file watcher, the SSE endpoint and the conflict banner go away.
- §9 "No hosting needed" and "Board file in the project folder; the dev server watches
  it": replaced by §3 and §10.
- §12 "the tool opens a board file by path and watches it": boards live in the database;
  a board goes into a hardware project's folder by download or `pull`.
- The bench sheet stays server-built (owner: fine as long as it is not heavy; it isn't).
  (Separately, on 2026-11-06 the owner asked for a page 2 on the bench sheet: both sides
  enlarged to fill the page, marked not to scale. That is a small change done on its own.)

## 12. Build order (owner's order)

1. **A live board on your own machine.** Server, SQLite, the API (no auth yet), Yjs live
   editing between open copies, revisions with shared undo and the history panel, the
   board list, import and download, pairing a device. Channel board 2 imported. Local
   mode only. Done when a paired bench tablet shows a change made at the computer without
   reloading, and the file watcher, the SSE endpoint and the conflict banner are gone.
2. **Accounts and sharing.** Public mode, GitHub and Google sign-in, the setup code and
   admin page, share links (view, edit, password, private), fork, the premium flag, trash.
3. **AI access.** Tokens, the token rules of §9, the MCP server, CLI `import`/`pull`.
4. **Hosting and safety.** The Docker image, daily backups, board bundles (export and
   import with full history) and download-all, the
   `wirebender/1` format docs (spec page, generated JSON Schema, example boards, rules for
   future versions), and the deploy of the owner's copy.

Each step gets its own implementation plan in `docs/superpowers/plans/`.

## 13. Claude's calls (the owner can overrule any)

- **Yjs relayed by our own server**, not PartyKit/Liveblocks: keeps one self-hostable
  container. Each board item is one Yjs value (item-level "later wins"), not a deep CRDT
  of points.
- **Server checks every update parses** and rejects one that would break the board.
- **SQLite + Drizzle** for the database; **nuxt-auth-utils** for GitHub/Google sign-in and
  sessions (the Nuxt team's module; also hashes share-link passwords).
- **Shared undo via server revisions** (an undo is a new revision), not each browser's own
  Yjs undo stack, so undoing the AI's change works for everyone.
- **Revisions grouped** per action and per author within ~2 s.
- **Trash 30 days; 14 daily backups.**
- **Public = unlisted**: viewable by link, never listed or searchable.
- **One share link per board**, regenerable.
- **Token limits** as listed in §9 (the owner said: same as the user, except account
  deletion "or sensible actions"; this is the list of sensible ones).
- **Mode set explicitly** (`WIREBENDER_MODE`; `pnpm dev` local, Docker public), not
  guessed from the listening address; loopback trusted only in local mode.
- **Disconnected copies are read-only**, no offline edit queue.
- **Edit links** allow everything that makes a revision (incl. undo and restore), not
  rename, trash or sharing; linked boards show under "Shared with me".
- **Pairing codes**: single-use, 10 minutes, devices listed and unpairable.
- **Local → public**: the admin takes over the local user's boards.
- **`revision` in files is informational**; base revision is a request field.
- Free-account limits against abuse (board size cap, e.g. 2 MB; request rate limits;
  a cap on boards per account) are the builder's call, set generously.

## 14. Left to the builder

- Database schema, API routes and shapes, revision storage format.
- The WebSocket protocol details and the Yjs ↔ `BoardFile` binding.
- Exact look of the board list, history panel, presence, sharing dialog and admin page,
  following the current editor's style.
- Thumbnails (rendered from `core/`; can be simple).
- Rate-limit and size-cap numbers.
