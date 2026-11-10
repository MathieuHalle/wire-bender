# WireBender dashboard layout — design

## Intent

WireBender is the best visualisation tool for building a protoboard: a **planning and
building** app, not a simulator (owner's words). A typical session: open a board to
review it, iterate on it with a Claude session changing it live, send it to the iPad or
iPhone at the bench to build it, print the build sheets, and share it if you want.

Today every page is a standalone page with its own back arrow and no shared navigation.
This project lays the foundation for WireBender as a proper SaaS: a real app shell, built
on the **Nuxt UI Dashboard template** (`https://github.com/nuxt-ui-templates/dashboard`,
preview `https://dashboard-template.nuxt.dev`), with clear sections that later features
plug into.

## Goals

- One dashboard shell (sidebar + page panels) for everything around the boards.
- A second, simple layout for the one-off pages (sign in, sign out, setup, pairing,
  account-pending-deletion).
- Move every existing feature into its new place. Nothing is lost, nothing is new.
- Old URLs keep working (redirects), so links in the README, bookmarks and server
  redirects do not break.

## Non-goals

- **No new features** (owner's call: "only the layout + move"). No "send to my iPad",
  no stats, no news. Features come later on this foundation.
- **Billing / plans.** A hosted-only module, not part of the open-source project, designed
  in a later session. (It can later just set the existing `isPremium` flag.)
- The signed-out home page's real content. Designed later.
- Any change to the board editor itself, the bench sheet, the API, or `core/`.

## Anti-goals

- The board editor losing screen space to dashboard chrome. It stays full-screen.
- Breaking a share link (`/b/:id`) or any `/api/*` route.
- Hiding a feature that exists today so well that the owner can't find it.

## Layouts

### 1. Dashboard layout (`app/layouts/dashboard.vue`)

Built from the template's pieces: `UDashboardGroup`, `UDashboardSidebar` (collapsible,
resizable as the template does it), `UDashboardPanel` + `UDashboardNavbar` per page,
`UDashboardSearch` (⌘K).

Sidebar, top to bottom:

- WireBender logo (`/icon.svg`) and name.
- Search (⌘K): searches the user's boards by name and the sidebar destinations. (Claude's
  call: what the template's search gives for free, fed with the board list already
  fetched by `/api/boards`; no new API.)
- **Boards**, with sub-items **My boards**, **Shared with me** (public mode only),
  **Trash**.
- **Settings**.
- Bottom: **Help & docs**, then the account menu (avatar, name; items: Account → Settings
  › Account, Server Admin if admin, Sign out). In local mode the account menu shows
  "Local" with no sign out.

(Owner's call: Devices and Connections are *not* in the sidebar; they are Settings tabs,
because you rarely touch them.)

### 2. Auth / one-off layout (`app/layouts/auth.vue`)

A centered card with the WireBender logo, no sidebar (owner's call: "a second layout for
all the one-off pages"). Used by `/login`, `/logout`, `/setup`, `/pair`, and the
account-pending-deletion page.

### Board editor: no dashboard layout

`/b/:id` stays full-screen, outside the dashboard (owner's call, option A). Its header
keeps its back arrow, now going to `/boards`. The bench sheet and print stay as they are.

## Pages and URLs

| URL | Layout | What | From today |
|-----|--------|------|------------|
| `/` | none / its own | Signed in (or local mode): redirect to `/boards`. Signed out: home page — for now today's intro text and sign-in buttons. | `index.vue` signed-out section |
| `/boards` | dashboard | My boards (cards with thumbnails, visibility badges, rename, duplicate, trash). Navbar: Import, New board. | `index.vue` "My boards" tab |
| `/boards/shared` | dashboard | Shared with me (public mode only; local mode redirects to `/boards`). Fork. | `index.vue` "Shared" tab |
| `/boards/trash` | dashboard | Trash: restore, delete for good. | `index.vue` "Trash" tab |
| `/b/:id` | none (full-screen) | Board editor, unchanged except as below. | unchanged |
| `/settings` | dashboard | Redirects to `/settings/account`. | — |
| `/settings/account` | dashboard | Name, avatar, linked sign-ins ("Also sign in with"), download all my boards, delete account. Local mode: the "local mode, nothing to sign in to" text and download all my boards. | `account.vue` |
| `/settings/devices` | dashboard | Paired devices (name, last seen, Unpair) and Pair a device (pairing code). **Local mode only**; the tab is hidden in public mode (public mode has no pairing). | `DevicesDialog`, `PairDialog` |
| `/settings/connections` | dashboard | API tokens, then the API & MCP docs (sign in with a token, change a board, errors, routes, MCP server). | `TokensPanel` (from `account.vue`) + `api.vue` |
| `/settings/admin` | dashboard | Server Admin: accounts with premium / admin / suspend, download every board. Admin only (others get today's not-found). Hidden in local mode. | `admin.vue` |
| `/login` | auth | Sign-in buttons (GitHub / Google). Signed in already: redirect to `/boards`. Local mode: redirect to `/boards`. Honours the existing "return to the board after sign-in" (`RETURN_KEY`). | `SignInButtons` from `index.vue` |
| `/logout` | auth | Signs out, then shows "Signed out" with a link to sign in again / home. | `AccountMenu` sign-out |
| `/account/deleted` | auth | Signed in as an account pending deletion: purge date, Restore, Sign out. | `account.vue` `deletedAt` branch |
| `/setup` | auth | Unchanged behaviour. After success, go to `/settings/admin`. | `setup.vue` |
| `/pair` | auth | Unchanged behaviour. | `pair.vue` |

Settings is one dashboard page with tabs (the template's settings pattern: a
`UNavigationMenu` under the navbar), in this order (owner's call):
**Account | Devices | Connections | (other tabs later) | Server Admin**. Tabs that don't
apply are hidden, not disabled.

### Redirects for old URLs

- `/account` → `/settings/account` (or `/account/deleted` when the account is pending
  deletion).
- `/admin` → `/settings/admin`.
- `/api` (the page) → `/settings/connections`. Careful: `server/utils/access.ts` treats
  the path `/api` specially; the redirect must not change how `/api/*` routes are served.
- These three are **server redirects** (Claude's call), run before the public-mode gate
  in `server/utils/access.ts`, so they work for a signed-out visitor too (today a
  signed-out `GET /api` gets the 401 JSON and an app-side redirect would never run).
  Only these exact paths; every `/api/*` route behaves exactly as today. Editing
  `access.ts` and its tests is in scope for this.
- Pending deletion: `server/middleware/access.ts` sends every page to `/account/deleted`
  (not `/account`), and exempts `/account/deleted` and `/logout`.
- Sign-in errors (`server/utils/oauth.ts`, Claude's call): the ones that happen while
  signed out (`suspended`, `deleted`, `oauth`) go to `/login?error=…`, which shows them;
  `taken` (linking a second sign-in, so signed in) goes to `/settings/account?error=taken`.
  `/setup?error=done` unchanged.
- `/pair` and `/setup` keep their URLs (the server and `useLiveBoard` point to `/pair`).

### Back after sign-in (Claude's call)

- OAuth success still lands on `/`. `/` reads the stored return path (`RETURN_KEY`) and
  goes there, else to `/boards`. This replaces the return handling in today's
  `index.vue` `onMounted`.
- `returnPath()` (`app/utils/boardView.ts`) widens from `/b/<id>` only to an allowlist:
  `/b/<id>`, `/boards`, `/boards/shared`, `/boards/trash`, `/settings/<known tab>`; path
  only, no query string, no other origin. The 10-minute limit stays. Anything else falls
  back to `/boards`.
- A signed-out visit to a dashboard URL stores that path and goes to `/login`.

## Changes to the board editor (`/b/:id`)

Only what the move needs:

- Back arrow goes to `/boards`.
- "Pair a device" and "Paired devices" leave the editor toolbar; they live in
  Settings › Devices. (Claude's call: you rarely touch them, owner's reasoning for moving
  them to Settings. The owner can keep a shortcut if they miss it.)
- "Sign in to edit" goes through `/login` (keeping the return-to-board behaviour).
- Everything else (2D/3D, side panels, sharing, history, bench sheet, presence) unchanged.

## Modes

- **Local mode** (this computer is trusted, no accounts): `/` → `/boards`; no Shared with
  me, no Server Admin; Settings shows Account (local text + download), Devices,
  Connections; account menu shows "Local", no sign out; `/login` and `/logout` redirect
  to `/boards`.
- **Public mode, signed in:** everything, Server Admin for the admin only; Devices hidden.
- **Public mode, signed out:** `/` is the home page; any dashboard URL sends you to
  `/login` and back after sign-in. Share links `/b/:id` still open without an account,
  as today.

## Help & docs

Claude's call: today the only docs are the README and the API page. "Help & docs" links
to the project README on GitHub (`https://github.com/MathieuHalle/wire-bender#readme`,
new tab) until there is a docs section. The API docs live in Settings › Connections.

## Constraints

- Project rules in `CLAUDE.md` still hold: `core/` untouched; advisory wording on
  findings unchanged; `reference/` read-only.
- Use the template's components and patterns; don't hand-roll a sidebar.
- Nuxt UI v4 is already installed (`@nuxt/ui ^4.12.0`); no new UI library.
- README: update the page paths it mentions (`/account`, `/admin`, the `/api` page).

## Left to the builder

- Exact sidebar icons, collapsed-sidebar behaviour on phones (template defaults are fine).
- Splitting today's `index.vue` (745 lines) into the three board pages and shared
  components.
- Whether board search in ⌘K reuses the loaded list or fetches it once on open.
- Tests: the existing `tests/app` style (pure helpers) for redirect rules and which tabs
  show in which mode.
