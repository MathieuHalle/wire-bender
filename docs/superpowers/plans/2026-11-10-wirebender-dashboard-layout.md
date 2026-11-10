# Dashboard layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every page around the boards into a Nuxt UI Dashboard shell, the one-off pages into a centered auth layout, and move today's features into their new URLs without adding any.

**Architecture:** `app.vue` renders `<NuxtLayout>`. Three layouts: `default` (today's `UMain`, used by the full-screen editor), `dashboard` (sidebar + ⌘K search, from the Nuxt UI Dashboard template), `auth` (centered card). Which lists/tabs show per mode, where `/` goes and the return-after-sign-in allowlist are pure helpers in `app/utils/` with unit tests; old URLs and sign-in redirects move on the server (`server/utils/access.ts`, `server/middleware/access.ts`, `server/utils/oauth.ts`).

**Tech Stack:** Nuxt 4, Nuxt UI 4 (`UDashboardGroup`, `UDashboardSidebar`, `UDashboardPanel`, `UDashboardNavbar`, `UDashboardSearch`, `UNavigationMenu`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-wirebender-dashboard-layout-design.md`

## Global Constraints

- No new features: every control that exists today exists after, in its new place; nothing else is added.
- `core/`, `reference/`, the bench sheet, every `/api/*` route and `/b/:id` share links behave exactly as today.
- Findings wording unchanged (ends with `Advisory only. Check the board with a meter before powering it.`).
- Use the template's components (`/docs/components/dashboard-*` via the `nuxt-ui` MCP tools, template source `https://github.com/nuxt-ui-templates/dashboard`); no hand-rolled sidebar, no new UI library.
- Settings tab order: **Account | Devices | Connections | Server Admin**; tabs that don't apply are hidden, not disabled.
- Devices: local mode only. Shared with me: public mode only. Server Admin: admin only, never in local mode.
- Work in a worktree (superpowers:using-git-worktrees). Before merging, stop the dev server on port 3001 (a merge under it drops live edits).
- Verification: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

## Review Focus

1. A signed-out visitor opening `/settings/connections` lands on `/login` and, after signing in, back on `/settings/connections` (Task 2 test: `returnPath` accepts it; Task 3 middleware stores it).
2. A signed-out visitor opening a share link `/b/:id` still sees the board with no sign-in (Task 1 middleware test keeps `/b/abc` anonymous `pass`; Task 3 never guards `/b/*`).
3. A session of an account pending deletion is sent to `/account/deleted` from every page, including `/boards` and `/settings/account`, and can still reach `/logout` (Task 1 tests).
4. `GET /api` (the old page) redirects, but `GET /api/boards`, `POST /api`, `/api/` and `/apix` are untouched (Task 1 `legacyRedirect` test).
5. Mode differences: local mode shows Devices, hides Shared with me and Server Admin; public mode hides Devices; a non-admin never sees Server Admin (Task 2 `settingsTabs`/`boardLists` tests).

---

## File Structure

- `server/utils/access.ts` — add `legacyRedirect`; `publicGate` exempts `/account/deleted` and `/logout`.
- `server/middleware/access.ts` — run `legacyRedirect` first; pending deletion → `/account/deleted`.
- `server/utils/oauth.ts` — new sign-in redirect targets.
- `app/utils/boardView.ts` — widen `returnPath`.
- `app/utils/nav.ts` (new) — mode rules: lists, tabs, `/` target, sign-in errors.
- `app/app.vue`, `app/layouts/{default,dashboard,auth}.vue` (new), `app/middleware/signed-in.ts` (new), `app/components/DashboardSearch.vue` (new).
- `app/pages/index.vue` (rewritten: home), `app/pages/boards/{index,shared,trash}.vue` (new), `app/composables/useBoardList.ts` (new) + board-list components split out of today's `index.vue`.
- `app/pages/settings.vue` + `app/pages/settings/{index,account,devices,connections,admin}.vue` (new); `app/pages/{account,admin,api}.vue` deleted; `DevicesDialog`/`PairDialog` become panels.
- `app/pages/{login,logout}.vue`, `app/pages/account/deleted.vue` (new); `setup.vue`, `pair.vue` move to the auth layout.
- `app/pages/b/[id].vue` — back arrow, pairing buttons removed, sign-in via `/login`.
- `README.md` — page paths.

---

### Task 1: Server — old URLs, pending deletion page, sign-in redirects

**Files:**
- Modify: `server/utils/access.ts` (`publicGate`, new `legacyRedirect`)
- Modify: `server/middleware/access.ts` (default handler, `signedIn`)
- Modify: `server/utils/oauth.ts` (`finishSignIn`, `failedSignIn`)
- Test: `tests/server/access.test.ts`, `tests/server/middleware.test.ts`, `tests/server/oauth.test.ts`

**Interfaces:**
- Produces: `legacyRedirect(method: string, path: string): string | null`; URLs `/account/deleted`, `/login?error=<code>`, `/settings/account?error=taken` that Tasks 5 and 6 render.

- [ ] **Step 1: Write the failing tests**

`tests/server/access.test.ts`, new `describe('legacyRedirect')`:

```ts
it('moves the old pages, keeping the query', () => {
  expect(legacyRedirect('GET', '/account')).toBe('/settings/account')
  expect(legacyRedirect('GET', '/account?error=taken')).toBe('/settings/account?error=taken')
  expect(legacyRedirect('HEAD', '/admin')).toBe('/settings/admin')
  expect(legacyRedirect('GET', '/api')).toBe('/settings/connections')
})
it('leaves everything else alone', () => {
  for (const p of ['/api/', '/api/boards', '/api/me', '/apix', '/account/deleted', '/admin/x', '/', '/b/abc', '/pair', '/setup'])
    expect(legacyRedirect('GET', p), p).toBeNull()
  expect(legacyRedirect('POST', '/api')).toBeNull()
  expect(legacyRedirect('POST', '/account')).toBeNull()
})
```

`tests/server/middleware.test.ts`:
- In "anonymous may read pages…" (line ~163) replace `'/account'` with `'/settings/account'`.
- New test `'old page URLs redirect for anyone, in both modes'`: public anonymous `GET /api` → `{ redirect: '/settings/connections', status: 302 }`; public anonymous `GET /account` → `/settings/account`; local stranger `GET /admin` → `/settings/admin`; public anonymous `GET /api/boards?list=mine` still `{ error: 'Sign in first.' }`.
- "a pendingDeletion session reaches /account only (R1)" (line ~243), renamed `'… reaches /account/deleted only (R1)'`: `GET /`, `/b/abc`, `/boards`, `/settings/account` → `{ redirect: '/account/deleted', status: 302 }`; `GET /account/deleted` and `GET /logout` → `undefined`.

`tests/server/oauth.test.ts`:
- `taken` → `'/settings/account?error=taken'`; `suspended` → `'/login?error=suspended'`; deleted account → `'/account/deleted'`; `failedSignIn` → `'/login?error=oauth'`. Successful sign-in stays `'/'`. Update the test titles to match.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/server/access.test.ts tests/server/middleware.test.ts tests/server/oauth.test.ts`
Expected: FAIL (`legacyRedirect` not exported; old redirect targets).

- [ ] **Step 3: Implement**

- `legacyRedirect` in `server/utils/access.ts`: `GET`/`HEAD` only; exact pathnames `/account` → `/settings/account`, `/admin` → `/settings/admin`, `/api` → `/settings/connections`; append the original query string. Doc comment: why it runs before the gates (a signed-out `GET /api` would otherwise be the 401 JSON).
- `publicGate`: the pending-deletion exemption becomes `pathname !== '/account/deleted' && pathname !== '/logout'`; update its doc comment.
- Middleware default handler: after the `refusal` check, `const to = legacyRedirect(event.method, event.path); if (to) return sendRedirect(event, to, 302)`, for both modes. `signedIn`: `'account'` → `sendRedirect(event, '/account/deleted', 302)`.
- `oauth.ts`: `!r.ok` → `r.reason === 'taken' ? '/settings/account?error=taken' : `/login?error=${r.reason}``; success `r.deleted ? '/account/deleted' : …`; `failedSignIn` → `/login?error=oauth`. Update the doc comment.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run tests/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server tests/server
git commit -m "feat(server): old page URLs redirect; sign-in errors go to /login, deletion to /account/deleted"
```

---

### Task 2: Navigation rules and the wider return path

**Files:**
- Create: `app/utils/nav.ts`
- Modify: `app/utils/boardView.ts:141-156` (`returnPath`)
- Test: `tests/app/nav.test.ts` (new), `tests/app/returnPath.test.ts`

**Interfaces:**
- Consumes: `Me` (`import type { Me } from '../composables/useMe'`).
- Produces (all in `app/utils/nav.ts`):
  - `type BoardList = 'mine' | 'shared' | 'trash'`; `boardLists(me: Me): BoardList[]`
  - `type SettingsTab = 'account' | 'devices' | 'connections' | 'admin'`; `settingsTabs(me: Me): SettingsTab[]` (in spec order)
  - `needsLogin(me: Me): boolean` — public mode, no user
  - `homeTarget(me: Me, back: string | null): string | null` — `null` means show the signed-out home page
  - `SIGN_IN_ERRORS: Record<string, string>` — moved verbatim from `app/pages/account.vue` `ERRORS`; `signInError(code: string | null): string | null` (unknown code → the `oauth` text, as today)
  - `returnPath` keeps its signature.

- [ ] **Step 1: Write the failing tests**

`tests/app/nav.test.ts` with fixtures `local = { mode: 'local', user: null, providers: [] }`, `anon` (public, no user), `ada` (public, user, not admin), `admin` (public, `isAdmin: true`):

```ts
expect(boardLists(local)).toEqual(['mine', 'trash'])
expect(boardLists(ada)).toEqual(['mine', 'shared', 'trash'])
expect(settingsTabs(local)).toEqual(['account', 'devices', 'connections'])
expect(settingsTabs(ada)).toEqual(['account', 'connections'])
expect(settingsTabs(admin)).toEqual(['account', 'connections', 'admin'])
expect(needsLogin(anon)).toBe(true); expect(needsLogin(local)).toBe(false); expect(needsLogin(ada)).toBe(false)
expect(homeTarget(anon, null)).toBeNull()
expect(homeTarget(ada, null)).toBe('/boards')
expect(homeTarget(local, null)).toBe('/boards')
expect(homeTarget(ada, '/settings/connections')).toBe('/settings/connections')
expect(homeTarget(anon, '/b/abc')).toBeNull()
expect(signInError(null)).toBeNull()
expect(signInError('suspended')).toBe(SIGN_IN_ERRORS.suspended)
expect(signInError('nonsense')).toBe(SIGN_IN_ERRORS.oauth)
```

`tests/app/returnPath.test.ts`, new `it('gives back the dashboard pages, nothing else')`:

```ts
for (const p of ['/boards', '/boards/shared', '/boards/trash', '/settings', '/settings/account', '/settings/devices', '/settings/connections', '/settings/admin'])
  expect(returnPath(returnEntry(p, 1000), 1000), p).toBe(p)
for (const p of ['/settings/evil', '/boards/x', '/boards?list=trash', '/settings/account?error=x', '/login', '/', '/boards/'])
  expect(returnPath(returnEntry(p, 1000), 1000), p).toBeNull()
```

(The existing foreign-entry test, which includes `/account`, must still pass.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/app/nav.test.ts tests/app/returnPath.test.ts`
Expected: FAIL (module missing; dashboard paths rejected).

- [ ] **Step 3: Implement** `app/utils/nav.ts` as above, and widen the final regex test in `returnPath` to also accept `^/boards(/(shared|trash))?$` and `^/settings(/(account|devices|connections|admin))?$`; update its doc comment.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run tests/app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/utils tests/app
git commit -m "feat(app): navigation rules per mode; return after sign-in to dashboard pages"
```

---

### Task 3: Layouts, sign-in guard and search

**Files:**
- Modify: `app/app.vue` → `<UApp><NuxtLayout><NuxtPage /></NuxtLayout></UApp>`
- Create: `app/layouts/default.vue` (`<UMain><slot /></UMain>`, so the editor renders as today)
- Create: `app/layouts/dashboard.vue`, `app/layouts/auth.vue`, `app/middleware/signed-in.ts`, `app/components/DashboardSearch.vue`
- Modify: `app/components/AccountMenu.vue`

**Interfaces:**
- Consumes: `boardLists`, `needsLogin` (Task 2); `RETURN_KEY`, `returnEntry`.
- Produces: `definePageMeta({ layout: 'dashboard', middleware: 'signed-in' })` for every dashboard page; `definePageMeta({ layout: 'auth' })` for one-off pages. Dashboard pages render a `UDashboardPanel` (with `#header` → `UDashboardNavbar`, `#body`) as their root.

- [ ] **Step 1: Dashboard layout.** `UDashboardGroup` > `UDashboardSidebar` (collapsible, resizable, as the template) + `<slot />`. Sidebar header: `/icon.svg` and "WireBender". Default slot: `UDashboardSearchButton`, then `UNavigationMenu` vertical with Boards (children from `boardLists(me)`: My boards `/boards`, Shared with me `/boards/shared`, Trash `/boards/trash`) and Settings (`/settings`). Footer: Help & docs (`https://github.com/MathieuHalle/wire-bender#readme`, `target="_blank"`), then `AccountMenu`. Icons: builder's choice (lucide).
- [ ] **Step 2: AccountMenu.** Items: Account → `/settings/account`; Server Admin → `/settings/admin` (admin only); Sign out → `/logout`. In local mode (`user` null) render a "Local" label with Settings → `/settings/account` and no sign out. Collapsed sidebar shows the avatar only (template behaviour).
- [ ] **Step 3: Search.** `DashboardSearch.vue`: `UDashboardSearch` with two groups — "Boards" (names from `GET /api/boards?list=mine`, fetched once when first opened, each → `/b/:id`) and "Go to" (the sidebar destinations). Mounted in the dashboard layout.
- [ ] **Step 4: Auth layout.** Full-height centered column, logo + "WireBender" linking to `/`, then a `UCard` (`max-w-md`) holding `<slot />`.
- [ ] **Step 5: `signed-in` middleware.** Client only (`if (import.meta.server) return`). `const me = await useMe().load()`; if `me && needsLogin(me)`: store `returnEntry(to.path)` under `RETURN_KEY` in `sessionStorage` (try/catch, as `SignInButtons`) and `return navigateTo('/login')`. Never applied to `/b/*`.
- [ ] **Step 6: Verify.** `pnpm typecheck && pnpm lint` — expected: no errors. (Pages adopt the layouts in Tasks 4–6.)
- [ ] **Step 7: Commit**

```bash
git add app
git commit -m "feat(app): dashboard and auth layouts, sign-in guard, board search"
```

---

### Task 4: Board pages

**Files:**
- Rewrite: `app/pages/index.vue` (home)
- Create: `app/pages/boards/index.vue`, `app/pages/boards/shared.vue`, `app/pages/boards/trash.vue`, `app/composables/useBoardList.ts`, plus components split out of today's `index.vue` (names and split: builder's call)
- Modify: `app/components/SignInButtons.vue` (comment: the return is handled by `/`)

**Interfaces:**
- Consumes: `homeTarget`, `boardLists` (Task 2); `RETURN_KEY`, `returnPath`; layout/middleware names (Task 3).
- Produces: `useBoardList(list: BoardList)` → `{ rows, sharedRows, status, refresh }` with today's 401-then-reload-me handling.

- [ ] **Step 1: `/` (home).** No layout. On mount: `load()` me; read and remove `RETURN_KEY` (try/catch); `const to = homeTarget(me, returnPath(stored))`; if `to`, `navigateTo(to, { replace: true })`; else render today's signed-out intro (heading, text, `SignInButtons`) — wrapped in the `auth` layout via `setPageLayout('auth')` when signed out. Keep the "Cannot reach the WireBender server." and "Loading…" states.
- [ ] **Step 2: `/boards`, `/boards/shared`, `/boards/trash`.** Each: `definePageMeta({ layout: 'dashboard', middleware: 'signed-in' })`, `UDashboardPanel` with navbar title (My boards / Shared with me / Trash). `/boards` navbar: Import and New board. Move today's behaviour unchanged: cards with thumbnails and visibility badges, rename, duplicate, fork, trash, restore, delete-for-good with typed name, the 30-day note, the empty texts in `EMPTY`, import errors, new-board modal. `/boards/shared` in local mode: `navigateTo('/boards', { replace: true })`. Rows link to `/b/:id` / `/b/:key` as today.
- [ ] **Step 3: Verify.** `pnpm typecheck && pnpm lint && pnpm test` — expected: pass. Then run the app (`run` skill; local mode `pnpm dev`) and check: `/` → `/boards`; create, rename, duplicate, trash, restore a board; import a `.wirebender.json` from `data/`; sidebar Trash and ⌘K search open the right pages.
- [ ] **Step 4: Commit**

```bash
git add app
git commit -m "feat(app): board lists move into the dashboard; / redirects or shows the home page"
```

---

### Task 5: Settings

**Files:**
- Create: `app/pages/settings.vue`, `app/pages/settings/{index,account,devices,connections,admin}.vue`
- Create: `app/components/DevicesPanel.vue`, `app/components/PairPanel.vue` (bodies of today's `DevicesDialog`/`PairDialog`, no modal)
- Delete: `app/pages/account.vue`, `app/pages/admin.vue`, `app/pages/api.vue`, `app/components/DevicesDialog.vue`, `app/components/PairDialog.vue`
- Modify: `app/components/TokensPanel.vue` (its `/api` link → the docs section on the same page, `#api`), `app/pages/setup.vue` (success → `/settings/admin`)

**Interfaces:**
- Consumes: `settingsTabs`, `signInError` (Task 2); layout/middleware (Task 3); `/settings/account?error=taken` (Task 1).

- [ ] **Step 1: `settings.vue`** (parent): dashboard layout + `signed-in`; `UDashboardPanel`, navbar "Settings", toolbar `UNavigationMenu` horizontal from `settingsTabs(me)` with labels Account, Devices, Connections, Server Admin; `<NuxtPage />`. `settings/index.vue` → `navigateTo('/settings/account', { replace: true })`.
- [ ] **Step 2: Account tab.** Today's `account.vue` signed-in content minus tokens: avatar, name + Save name, "Also sign in with", Download all my boards, Delete account, the `?error=taken` alert (via `signInError`). Local mode: the two "local mode" paragraphs + Download all my boards. Drop the deleted-account branch (Task 6) and the "Back to boards" button.
- [ ] **Step 3: Devices tab.** `PairPanel` then `DevicesPanel`, same calls and texts as the dialogs. Public mode: `navigateTo('/settings/account', { replace: true })`.
- [ ] **Step 4: Connections tab.** `TokensPanel`, then today's `api.vue` content (sign in with a token, change a board, errors, routes, MCP server; `ROUTES` and `MCP_ADD` unchanged) under an `id="api"` heading "API & MCP". Keep the "keep in step with the README" comment.
- [ ] **Step 5: Server Admin tab.** Today's `admin.vue` (accounts table, switches, Download every board, the not-found state for non-admins). Local mode: redirect to `/settings/account`.
- [ ] **Step 6: Verify.** `pnpm typecheck && pnpm lint && pnpm test` — pass. Run the app: local mode shows Account / Devices / Connections; create and revoke a token; show a pairing code; `/account`, `/api`, `/admin` redirect; `pnpm dev:public` signed out → `/settings/connections` goes to `/login`.
- [ ] **Step 7: Commit**

```bash
git add -A app
git commit -m "feat(app): Settings with Account, Devices, Connections and Server Admin tabs"
```

---

### Task 6: One-off pages and the editor

**Files:**
- Create: `app/pages/login.vue`, `app/pages/logout.vue`, `app/pages/account/deleted.vue`
- Modify: `app/pages/setup.vue`, `app/pages/pair.vue` (`definePageMeta({ layout: 'auth' })`, drop their own page chrome/back arrows that the layout replaces)
- Modify: `app/pages/b/[id].vue` (lines ~409, ~453-487, ~504, ~522, ~591)
- Modify: `README.md` (lines ~79, ~103, ~269, ~275 and any other `/account`, `/admin`, `/api` page mention)

**Interfaces:**
- Consumes: `signInError` (Task 2), URLs from Task 1, `RETURN_KEY`/`returnEntry`.

- [ ] **Step 1: `/login`.** Auth layout. Signed in or local mode → `navigateTo('/boards', { replace: true })`. Else `?error` alert via `signInError`, then `SignInButtons :providers` (no `returnTo`: a stored return is left in place for `/` to use).
- [ ] **Step 2: `/logout`.** Auth layout. Local mode → `/boards`. Else on mount `signOut()`, then "Signed out." with buttons Sign in again (`/login`) and Home (`/`).
- [ ] **Step 3: `/account/deleted`.** Auth layout. Today's `account.vue` `deletedAt` branch: the text with the purge date, Restore (`POST /api/me/restore`, then `/boards`), Sign out (`/logout`). A visitor whose account is not deleted → `/boards`.
- [ ] **Step 4: Editor.** Logo/back link and both "Back to the board list" → `/boards`. Remove the Pair a device / Paired devices buttons and dialogs (and `canPair`, `pairing`, `devicesOpen`). Replace `SignInButtons` with a "Sign in to edit" `UButton` that stores `returnEntry(`/b/${id}`)` under `RETURN_KEY` then goes to `/login`. Nothing else changes.
- [ ] **Step 5: README.** Paths: `/account` → Settings › Account (`/settings/account`), `/admin` → `/settings/admin`, "The app's `/api` page" → Settings › Connections (`/settings/connections`), tokens are made in Settings › Connections, Restore is on `/account/deleted`.
- [ ] **Step 6: Verify.** `pnpm test && pnpm typecheck && pnpm lint` — pass. Run the app in public mode (`pnpm dev:public`, a sign-in provider configured if available): signed out, open a share link `/b/:id` → board shows; "Sign in to edit" → `/login` → after sign-in back on the board; `/logout` signs out. Local mode: editor has no pairing buttons; back arrow → `/boards`; bench sheet still opens.
- [ ] **Step 7: Commit**

```bash
git add -A app README.md
git commit -m "feat(app): login, logout and deleted-account pages; editor goes back to /boards"
```
