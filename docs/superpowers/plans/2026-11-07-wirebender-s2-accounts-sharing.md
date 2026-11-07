# WireBender service step 2 (accounts and sharing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The same server can run in **public mode**: people sign in with GitHub or Google, own boards, share each board with one regenerable link (view, edit, password, private), fork, and use a trash. A setup code makes the first admin, who can set premium and suspend accounts. Local mode keeps working as in step 1. The step 1 multi-author debts (ruling R18) are paid first.

**Architecture:**
- **One question per request: who is it, and what may they do with this board?**
  - `whoIs(source)` answers the first: the local user (local mode), a signed-in account, or anonymous.
  - `access(db, who, key, unlocked)` answers the second: a role `owner | edit | view`, or 401/404.
  - Every API route and the board socket ask these two questions and nothing else.
- **A board is reached by a key.**
  - The key is either the board's id (only its owner can use it) or its share link id (`linkId`, a separate random UUID).
  - Regenerating the link changes `linkId`. Old links die; the owner's own URLs keep working.
  - Non-owners never see the board id.
- **Sessions use `nuxt-auth-utils`** (sealed cookie), with GitHub and Google OAuth handlers. Accounts are rows in SQLite.
  - There is no merging by email. A second provider is linked only while signed in.
- **Local mode** maps every trusted request (loopback or a paired device) to one local user `local`, who is owner, admin and premium. Sharing is hidden in local mode.

**Tech Stack:** As in step 1, plus `nuxt-auth-utils` (pin the exact version installed, 0.6.x). Its `hashPassword`/`verifyPassword` hash link passwords.

**Spec:** `docs/superpowers/specs/2026-11-06-wirebender-service-design.md`, §3 (modes, setup code, local → public), §4 (accounts, boards, fork, trash), §5 (sharing), §8 (soft delete), §12 step 2. Step 1's plan and ledger rulings still hold unless a task here changes them.

## Global Constraints

- All step 1 constraints still apply:
  - `core/` is pure;
  - Yjs code lives only in `shared/`, `app/` and `server/`;
  - the UI is in English;
  - findings end with the advisory sentence;
  - `reference/` is read-only;
  - pin exact versions;
  - commit trailers as in step 1.
- **Modes:** `WIREBENDER_MODE` is `local` or `public`; anything else stops the server with `WIREBENDER_MODE must be local or public`.
  - Public mode also stops without `WIREBENDER_URL` (`public mode needs WIREBENDER_URL, the address people use to reach this server`).
  - Public mode also stops without at least one provider pair (`public mode needs a sign-in provider: set NUXT_OAUTH_GITHUB_CLIENT_ID and NUXT_OAUTH_GITHUB_CLIENT_SECRET, or the Google pair`).
  - `pnpm dev` stays local. Add `pnpm dev:public` = `WIREBENDER_MODE=public nuxt dev`.
- **Public mode never trusts loopback or paired devices.** The pairing routes answer 404 there.
  - The Host/Origin deny checks compare against `WIREBENDER_URL`'s host instead of the machine's own names.
- **Session secret:** if `NUXT_SESSION_PASSWORD` is unset, generate 32 random bytes once into `<data>/session-secret` (mode 0600) and use it, so sessions survive restarts.
- **Nothing is overwritten** (step 1). Two exceptions may delete rows, both only by `purge()`:
  - a board 30 days after it was trashed (`TRASH_DAYS = 30`);
  - an account 30 days after its deletion was asked, with its boards.
  - Revisions of a purged board go with it. Nothing else ever deletes a board or a revision.
- **Migrations only add** tables and columns (spec §8).
- **Roles:**
  - The owner can do everything.
  - `edit`, signed in: everything that makes a revision (live edits, PUT, undo, redo, restore), plus read.
  - `view` (and `edit` while anonymous): read, 3D, check, bench, download, history read-only, fork when signed in.
  - Only the owner may rename, trash, change sharing, or regenerate the link.
- **Visibility:** `view | edit | private`, plus an optional link password.
  - Free accounts may set only `view` or `edit` and no password (`403`, `Premium is needed for private boards and link passwords.`).
  - Losing premium keeps what exists. Lowering visibility (private → view) or removing a password is always allowed.
- **Limits:**
  - `FREE_BOARD_LIMIT = 200` and `PREMIUM_BOARD_LIMIT = 2000` boards not in the trash.
  - At most 30 creates/imports/forks per user per minute (`429`).
  - Board size stays `MAX_BOARD_BYTES`.
  - Link unlock and setup code: 5 wrong tries per address per 10 min, then `429`.
- **Close codes added:** `4403` means access changed. The client reconnects fresh and re-checks its role; on 4404 it stops.
- **Authors:** an account's revisions use its display name, and also store `author_id`. The local user keeps `Local · <device>`.

## Review Focus

1. **Access lowered while someone is live.** The owner regenerates the link, or lowers it to view or private, while a visitor is editing. Within a second the visitor can no longer write, and on reconnect gets the new role (or 404). → Task 5 test `regenerating the link closes link peers with 4403`.
2. **Reaching a board by its id without owning it.** It must look exactly like a board that doesn't exist (404, same body), on the API and the socket. No response to a non-owner contains the board id. → Task 4 tests `board id is 404 for non-owners` and `link responses carry the link id only`.
3. **A free account calling the sharing API directly** to set `private` or a password gets 403. A board made private while premium stays private after the flag is cleared. → Task 5 test `premium rules hold on the API`.
4. **Signing in with a second provider while signed out** creates a new account. It never joins an existing one with the same email. Linking happens only from a signed-in session. → Task 3 test `a new identity while signed out is a new account`.
5. **Purge deletes only what is due**: boards trashed more than 30 days ago and accounts deleted more than 30 days ago. A board restored from the trash keeps its whole history. → Task 6 tests `purge keeps boards trashed 29 days ago` and `untrash keeps every revision`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `server/db/schema.ts`, new migration | users, identities, setup, link visits; board ownership, sharing and trash columns; `revisions.author_id` |
| `server/utils/who.ts` | modes, `whoIs`, the local user, session secret |
| `server/utils/accounts.ts` | `signIn`, linking, suspend, delete/restore account, setup code, admin |
| `server/utils/boardAccess.ts` | `access()` roles, link unlock, shared-with-me visits |
| `server/utils/sharing.ts` | visibility, password, regenerate, premium rules, kicking peers |
| `server/utils/lifecycle.ts` | fork/duplicate, trash/untrash/delete, `purge()`, limits |
| `server/utils/rooms.ts` | per-author groups, create-collision check, peers with roles, kick |
| `server/routes/_ws/board/[id].ts` | key + role per peer, commands over the socket |
| `server/routes/auth/{github,google}.get.ts` | OAuth handlers (nuxt-auth-utils) |
| `server/api/**` | routes listed per task |
| `app/pages/index.vue`, `b/[id].vue`, `setup.vue`, `admin.vue`, `account.vue` | lists, editor/visitor view, setup, admin, account |
| `app/components/ShareDialog.vue`, `SignInButtons.vue` | sharing, sign-in |

---

### Task 1: Multi-author correctness (step 1 ruling R18)

**Files:** Modify `server/utils/rooms.ts`, `shared/yboard.ts`, `server/routes/_ws/board/[id].ts`, `app/composables/useLiveBoard.ts`, `server/utils/boards.ts` (`recover`). Test `tests/server/rooms.test.ts`, `tests/shared/yboard.test.ts`, `tests/app/useLiveBoard.test.ts`.

**Interfaces:**
- Produces:
  - `sameItems(a: BoardFile, b: BoardFile): boolean` in `shared/yboard.ts`. It compares by section → id → `stable(value)`, records by key and singles by `stable`, so array order is ignored. `rooms.ts` and `recover` use it instead of `stable(whole board)`.
  - Per-author groups: `Room` records, per author, the item keys (`section:id`, `record:key`, `singles:name`) their accepted updates touched. `closeGroup(author)` commits the **head board with that author's keys replaced by their current values** (deleted keys removed). If that composed board doesn't parse, all open groups are committed together as one revision, with author = the authors joined by `, `.
  - **Create-collision check** in `Room.check`: an update that sets a section key which, in the server doc, already holds a live value, written by an item the update's own item has no origin link to (a concurrent create), is rejected. The reason is `<id> was just created by someone else; draw it again`. Editing an existing item the client had seen stays "later wins" (spec §6).
  - **Commands over the socket:** message type `3` = command, `varString` JSON `{ op: 'undo' | 'redo', id: number }`. The server answers with type `3` `{ id, ok: boolean, reason?: string }`, handled in order after the same socket's earlier updates. `useLiveBoard.undo/redo` send it instead of POSTing. The HTTP routes stay for the API.
  - Pairing URL (R18 item 9): `lanAddress()` prefers interfaces named `en*`, `eth*`, `wlan*`, `wl*`. It skips `utun*`, `bridge*`, `docker*`, `vboxnet*`, `tailscale*`, and addresses in `100.64.0.0/10`. It falls back to the old rule.
- [ ] **Step 1: Failing tests:**
  - `two authors' interleaved edits commit under their own names`: A edits T1, B edits P2 in A's window, A's group closes first. Revision n is A's, with T1 changed and P2 not; then B's has both.
  - `composed board that doesn't parse commits both as one`, with author `A, B`.
  - `concurrent create of the same id is rejected`: two docs from the same state both add `trails:T40`. The second update to reach the room gets the exact reason.
  - `editing an item someone else created, after seeing it, is accepted`.
  - `restore then a cancelling edit makes no revision` (order-insensitive compare).
  - `undo command is ordered after the same socket's edit` (handler test with the real message encoding).
  - `lanAddress skips utun and 100.64/10`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; full suite, typecheck, lint.
- [ ] **Step 5:** Commit `fix(server): per-author revisions, create collisions, ordered undo`.

### Task 2: Schema for accounts, ownership, sharing and trash

**Files:** Modify `server/db/schema.ts`, `server/utils/boards.ts`; generate a migration (`pnpm db:generate`). Test `tests/server/db.test.ts`, `tests/server/boards.test.ts`.

**Interfaces:**
- Produces tables:
  - `users`: `id` text pk (uuid; `'local'` for the local user), `name`, `avatar` (nullable), `is_admin`, `is_premium` (integer 0/1), `created_at`, `suspended_at` (nullable), `deleted_at` (nullable).
  - `identities`: `provider` (`github | google`), `provider_id`, `user_id`; pk (`provider`, `provider_id`).
  - `setup`: one row, `code_hash` (nullable), `done_at` (nullable).
  - `link_visits`: `user_id`, `board_id`, `link_id`, `last_opened`; pk (`user_id`, `board_id`).
- Produces columns:
  - `boards`: `owner_id` (not null, default `'local'`), `link_id` (not null, unique; existing rows get a fresh UUID in the migration), `visibility` (`view | edit | private`, default `view`), `password_hash` (nullable), `trashed_at` (nullable), `forked_from` (nullable board id).
  - `revisions`: `author_id` (nullable).
  - `REVISION_HOW` gains `fork`.
- The migration inserts the local user (`id 'local'`, `name 'Local'`, admin, premium) if missing. That makes every existing board the local user's.
- `boards.ts` changes:
  - `createBoard(db, board, how, author, ownerId = 'local', authorId?)`;
  - `listBoards(db, ownerId, which: 'mine' | 'trash')` (newest change first; `mine` excludes trashed);
  - `getBoardRow(db, id)` returns the new columns too;
  - `getBoardByLink(db, linkId)`;
  - `commitRevision` takes an optional `authorId`.
- [ ] **Step 1: Failing tests:**
  - `migration keeps step 1 boards and gives them to the local user`: copy a step 1 db fixture made with the old schema, migrate, and check owner `local`, a link id, `view`, and all revisions kept.
  - `link ids are unique`.
  - `listBoards excludes trashed from mine and lists them in trash`.
- [ ] **Step 2–4** as usual. **Step 5:** Commit `feat(db): accounts, ownership, sharing and trash columns`.

### Task 3: Modes, who is asking, and sign-in

**Files:** Create `server/utils/who.ts`, `server/utils/accounts.ts`, `server/routes/auth/github.get.ts`, `server/routes/auth/google.get.ts`, `server/api/me.get.ts`, `server/api/me.patch.ts`, `app/components/SignInButtons.vue`, `app/pages/account.vue`. Modify `server/plugins/startup.ts`, `server/middleware/access.ts`, `server/utils/access.ts` (`checkMode` moves to `who.ts`; refusal in public mode), `nuxt.config.ts` (module `nuxt-auth-utils`), `package.json`. Test `tests/server/who.test.ts`, `tests/server/accounts.test.ts`, `tests/server/middleware.test.ts`.

**Interfaces:**
- Produces:
  - `checkMode(env): 'local' | 'public'`, which throws the exact Global Constraints messages.
  - `type Who = { kind: 'local', userId: 'local', author: string, device?: {id, name} } | { kind: 'user', userId: string, author: string, isAdmin: boolean, isPremium: boolean } | { kind: 'anonymous' }`.
  - `whoIs(source: H3Event | ws upgrade request | ws peer): Promise<Who>`.
    - In local mode, `trust()` from step 1 maps to `local`; untrusted gives `anonymous`, and the step 1 gate still blocks it.
    - In public mode, the session's `user.id` is loaded from `users` on every call. A suspended or deleted user counts as `anonymous`, and their session is cleared.
  - `signIn(db, provider, profile: { id: string, name: string, avatar?: string }, current?: string): { ok: true, userId } | { ok: false, reason: 'suspended' | 'deleted' | 'taken' }`:
    - a known identity gives its user;
    - unknown, with `current` set: link it to `current`;
    - unknown, signed out: a new user;
    - an identity already linked to another user while linking: `taken`.
  - `GET /api/me` returns `{ mode, user: { id, name, avatar, isAdmin, isPremium, providers: string[], deletedAt } | null, providers: ('github'|'google')[] }`, where the last field lists the configured providers. `PATCH /api/me {name}` sets the name, 1–60 chars, control and format characters stripped.
  - Public-mode gate:
    - Anonymous requests pass for pages, `GET /api/me`, `/auth/*` and the board read routes (Task 4 decides per board).
    - Writes need a signed-in user.
    - The pairing routes return 404.
  - Middleware integration tests (step 1 deferred minor) drive `server/middleware/access.ts` and the socket `upgrade` hook with crossws-shaped sources.
- [ ] **Step 1: Failing tests:**
  - `checkMode` for each message.
  - `public mode does not trust loopback`.
  - `a new identity while signed out is a new account` (Review Focus 4).
  - `linking while signed in joins the identity`.
  - `an identity of another account can't be linked` (`taken`).
  - `suspended user is anonymous and can't sign in`.
  - `session secret is created once and reused`.
  - `public refusal compares Host with WIREBENDER_URL`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(server): public mode, sign-in with GitHub and Google`.

### Task 4: Board access by key and role

**Files:** Create `server/utils/boardAccess.ts`, `server/api/links/[linkId]/unlock.post.ts`. Modify every route in `server/api/boards/**`, `server/utils/api.ts` (callers pass `{ key, role, who }`), `server/routes/_ws/board/[id].ts`, `server/utils/rooms.ts` (peer role). Test `tests/server/boardAccess.test.ts`, `tests/server/api.test.ts`, `tests/server/rooms.test.ts`.

**Interfaces:**
- Produces:
  - `access(db, who, key, unlocked: string[]): { ok: true, boardId, role: 'owner' | 'edit' | 'view', signInToEdit: boolean, viaLink: boolean } | { ok: false, status: 401 | 404 }`:
    - `key` is the board id: `owner` if `who` owns it (the local user owns everything it owns), else 404.
    - `key` is a link id of a non-trashed board whose owner isn't deleted: `private` gives 404 (owner included). A password the session hasn't unlocked gives 401 `{ password: true }`. Otherwise `edit` or `view` follow the setting, and an anonymous visitor on an edit link gets `view` with `signInToEdit: true`.
    - A trashed board is 404 for everyone except its owner by board id.
  - `POST /api/links/:linkId/unlock {password}`: verifies with `verifyPassword` and adds `linkId` to the session's `unlocked` list (at most 50). Wrong tries are limited per the Global Constraints.
  - Every board route checks the role it needs: read routes need `view`; PUT, undo, redo and restore need `edit`; PATCH (rename) needs `owner`. A failure gives the same 404 body as an unknown board, or 403 `{ error: 'Sign in to edit.' }` for a signed-out visitor on an edit link.
  - Responses to non-owners use the key as `id` and never include the board id or `forked_from`. `GET` adds `{ role, signInToEdit, owner: { name } }`.
  - Socket: `/_ws/board/:key` runs `access` at upgrade and again on open. A `view` peer's sync updates and commands are refused with 4403 `view only`. The room keeps each peer's `role` and `viaLink`.
  - A signed-in non-owner who opens a board by link gets a `link_visits` row (upsert, `last_opened`).
- [ ] **Step 1: Failing tests:**
  - `board id is 404 for non-owners` (API and upgrade, same body as an unknown id) (Review Focus 2).
  - `link responses carry the link id only` (grep the JSON for the board id).
  - `private link is 404 even for the owner by link`.
  - `password link needs unlock, then opens`.
  - `five wrong passwords then 429`.
  - `anonymous on an edit link can read but PUT is 403 Sign in to edit.`
  - `view peer's update closes it with 4403`.
  - `trashed board is 404 by link`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(server): board access by owner or share link`.

### Task 5: Sharing settings

**Files:** Create `server/utils/sharing.ts`, `server/api/boards/[id]/sharing.get.ts`, `sharing.patch.ts`, `sharing/regenerate.post.ts`, `app/components/ShareDialog.vue`. Modify `app/pages/b/[id].vue` (Share button, owner only, hidden in local mode). Test `tests/server/sharing.test.ts`.

**Interfaces:**
- Produces:
  - `GET .../sharing` (owner only) returns `{ visibility, hasPassword, link: '<WIREBENDER_URL>/b/<linkId>', canUsePremium }`.
  - `PATCH .../sharing { visibility?, password?: string | null }`:
    - passwords are 4–100 chars and hashed with `hashPassword`;
    - `null` removes the password;
    - premium rules as in the Global Constraints.
  - `POST .../sharing/regenerate` sets a new `linkId` and returns the new link.
  - After any change, `kickLinkPeers(boardId)` closes every peer that joined via a link with 4403. Their sessions keep no unlock for the old link id.
  - `ShareDialog`:
    - the link with a Copy button;
    - a radio group: View / Edit / Private, with Private disabled and a "Premium" badge when not allowed;
    - a password field (premium only);
    - a "New link" button that confirms first ("The current link will stop working.").
- [ ] **Step 1: Failing tests:**
  - `premium rules hold on the API` (Review Focus 3): free gets 403 on private and on a password; premium works; after `is_premium` is cleared the board stays private, a new password gives 403, and removal works.
  - `regenerating the link closes link peers with 4403` and the old link is 404 (Review Focus 1).
  - `lowering edit to view closes link peers`.
  - `non-owner can't read or change sharing` (404).
- [ ] **Step 2–4.** **Step 5:** Commit `feat(sharing): link settings, passwords and regenerate`.

### Task 6: Fork, trash, account deletion, purge and limits

**Files:** Create `server/utils/lifecycle.ts`, `server/api/boards/[id]/fork.post.ts`, `trash.post.ts`, `untrash.post.ts`, `server/api/boards/[id].delete.ts`, `server/api/me.delete.ts`, `server/api/me/restore.post.ts`. Modify `server/plugins/startup.ts` (purge at start and every 24 h), `server/api/boards/index.post.ts` (limits). Test `tests/server/lifecycle.test.ts`.

**Interfaces:**
- Produces:
  - `fork(db, who, key): { id }`. It needs `view` and a signed-in user. The new board belongs to `who`, starts at the source's current board with one revision `how: 'fork'` and summary `forked from <name>`, and `forked_from` = source board id. On your own board it acts as duplicate, named `<name> (copy)`.
  - `GET /api/boards/:id` for the fork's owner includes `forkedFrom: { key, name } | null`, where `key` is the source's current link id. It is null if the source is now private, trashed or gone, or if the fork's owner owns the source, in which case it is the board id.
  - `trash` / `untrash` are owner only, set or clear `trashed_at`, and kick all non-owner peers.
  - `DELETE /api/boards/:id` with body `{ confirm: <board name> }` works only on a trashed board and deletes it now. It is the one immediate delete.
  - `DELETE /api/me` sets `deleted_at` and signs out. `POST /api/me/restore` clears it (allowed while signed in during the 30 days: `signIn` with `deleted` returns the user and the UI offers Restore).
  - `purge(db, now)` deletes boards with `trashed_at < now - 30 d`, and users with `deleted_at < now - 30 d` together with their boards, identities and visits.
  - Limits: board caps and the create rate, as in the Global Constraints (`429` / `403 { error: 'Board limit reached (200). Move some to the trash or ask for premium.' }`).
- [ ] **Step 1: Failing tests:**
  - `purge keeps boards trashed 29 days ago` (Review Focus 5).
  - `purge removes boards trashed 31 days ago and their revisions`.
  - `untrash keeps every revision`.
  - `fork copies the board, not the history`.
  - `forkedFrom hides when the source turns private`.
  - `edit-link visitor can't trash or rename`.
  - `deleted account's links are 404, and restore brings them back`.
  - `the 201st board is refused for a free account`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(boards): fork, trash, account deletion and purge`.

### Task 7: Board lists and the visitor view

**Files:** Modify `app/pages/index.vue`, `app/pages/b/[id].vue`, `app/composables/useLiveBoard.ts` (role, 4403), `server/api/boards/index.get.ts` (`?list=mine|shared|trash`). Create `server/api/boards/[id]/thumbnail.get.ts`. Test `tests/server/api.test.ts` (lists, thumbnail), `tests/app/useLiveBoard.test.ts`.

**Interfaces:**
- Produces:
  - `GET /api/boards?list=shared` returns the visits whose link still opens for this user (same `linkId`, not private, not trashed, owner not deleted), as `{ key: linkId, name, owner, role, lastOpened }`.
  - `thumbnail` (needs `view`) returns an SVG from `export/svg.ts` `boardOverviewSvg(board, 'top', { labelSize: 0 })`, with `Cache-Control: private, max-age=60`.
  - The board list page has three tabs: **My boards**, **Shared with me**, **Trash** (Trash shows Restore and Delete for good, with a type-the-name confirm). Rows show a thumbnail, name, last change, visibility badge and actions: Open, Rename, Duplicate, Download, Share, Move to trash. The header shows the account menu (Account, Admin for admins, Sign out), or SignInButtons.
  - Signed out in public mode, `/` shows a short intro with SignInButtons. In local mode it opens the list straight away, as today.
  - Visitor view on `/b/<linkId>`:
    - the editor with tools locked;
    - a banner `Viewing <name> by <owner>.` with **Sign in to edit** (edit link, signed out), **Fork** (signed in), or nothing else;
    - a password prompt page for 401.
  - Presence shows signed-in people by name and avatar, and anonymous visitors as `Guest`.
  - `useLiveBoard` keeps `role`. Close 4403 reconnects fresh once and re-reads the role; if it is still denied it shows `You no longer have access to this board.` and stops.
- [ ] **Step 1: Failing tests:**
  - `shared list drops a board whose link was regenerated`.
  - `shared list never shows private boards`.
  - `thumbnail needs view`.
  - `4403 reconnects once, then stops on 4404` (store test).
- [ ] **Step 2–4**, then a browser look at the three tabs and the visitor banner on :3002. **Step 5:** Commit `feat(app): board lists, shared with me, trash and the visitor view`.

### Task 8: Setup code, admin page, local → public

**Files:** Modify `server/utils/accounts.ts`, `server/plugins/startup.ts`. Create `server/api/setup.post.ts`, `server/api/admin/users.get.ts`, `server/api/admin/users/[id].patch.ts`, `app/pages/setup.vue`, `app/pages/admin.vue`. Test `tests/server/setup.test.ts`, `tests/server/admin.test.ts`.

**Interfaces:**
- Produces:
  - At start in public mode with no admin, `newSetupCode(db): string` makes 12 chars from `ABCDEFGHJKMNPQRSTVWXYZ23456789`, shown as `XXXX-XXXX-XXXX`. It stores the sha256 and logs `[wirebender] setup code: <code> — enter it at <WIREBENDER_URL>/setup`. Each start makes a new code while no admin exists, and the old one stops working.
  - `POST /api/setup {code}` checks the code (dashes and case ignored; wrong tries limited) and puts `setupOk: true` in the session. The next `signIn` while `setupOk` and no admin exists:
    - makes that user admin and premium;
    - marks setup done (`done_at`, `code_hash` null);
    - **moves every board owned by `local` to that user**, with its history (spec §3).
  - Once an admin exists, `/api/setup` returns 410 `{ error: 'Setup is done.' }`.
  - `GET /api/admin/users` (admin only, else 404) returns `{ id, name, avatar, providers, boards, createdAt, isPremium, isAdmin, suspendedAt, deletedAt }[]`, newest first.
  - `PATCH /api/admin/users/:id { premium?: boolean, suspended?: boolean }`. An admin can't suspend themselves (400). Suspending closes that user's sockets.
  - `admin.vue` is a table with a premium switch and a Suspend/Unsuspend button per row. `setup.vue` has a code field, then SignInButtons.
- [ ] **Step 1: Failing tests:**
  - `setup code works once, then 410`.
  - `a restart makes the old code useless`.
  - `setup admin takes over the local user's boards with their revisions`.
  - `non-admin gets 404 from admin routes`.
  - `suspend closes sockets and blocks sign-in`.
  - `admin can't suspend themselves`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(admin): setup code, accounts page, local boards move to the admin`.

### Task 9: Docs and the browser check

**Files:** Modify `README.md` (modes; public mode env: `WIREBENDER_URL`, OAuth app setup with callback `<WIREBENDER_URL>/auth/github` and `/auth/google`, `NUXT_SESSION_PASSWORD` optional; sharing; trash; admin), `CLAUDE.md` (API keys are board ids or link ids; roles).

- [ ] **Step 1:** Ask the owner for a GitHub OAuth app (client id and secret, callback `http://localhost:3002/auth/github`); Google is optional. Never commit them: use a scratch `.env` outside the repo.
- [ ] **Step 2:** `WIREBENDER_MODE=public WIREBENDER_URL=http://localhost:3002 PORT=3002 WIREBENDER_DATA=<scratch> pnpm dev:public` with a copy of a local-mode data folder holding channel board 2.
  - Setup code from the log → sign in → admin, and channel board 2 is now yours with its history.
- [ ] **Step 3:** In a second browser profile (or incognito):
  - open the view link → read-only, 3D and bench work;
  - switch to edit → "Sign in to edit";
  - sign in → edit live; it shows in Shared with me;
  - regenerate → the visitor tab loses access.
- [ ] **Step 4:** Premium off: Private is disabled. Admin sets premium: private works, and the link is 404.
- [ ] **Step 5:**
  - Fork from the visitor account.
  - Trash, then restore.
  - Delete the account, then restore it.
- [ ] **Step 6:** `pnpm dev` (local) on another scratch folder still works as in step 1.
- [ ] **Step 7:** Commit `docs: public mode, sign-in, sharing and admin`.

## After this plan

Step 2 is done when a friend opens the owner's link, looks at both sides and in 3D, and forks it (spec §1). Next is step 3: tokens, MCP and the CLI's `import`/`pull`.
