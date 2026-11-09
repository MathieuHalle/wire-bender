<script setup lang="ts">
// The API page: static help for scripts and AI tools. The route table is the README's; keep them in step.
useHead({ title: 'API · WireBender' })

const ROUTES: [string, string][] = [
  ['GET /api/boards?list=mine|shared|trash', 'list your boards (`id`, `name`, `head`, `visibility`, `hasPassword`, ...; `mine` by default), those in the trash, or those shared with you (`key`, `name`, `owner`, `role`, `lastOpened`)'],
  ['POST /api/boards', '`{ "board": <board json> }` imports; `{ "name", "cols", "rows", "type" }` creates an empty board; answers `{ id }`'],
  ['POST /api/boards/import-bundle', 'a bundle zip as the raw body (`Content-Type: application/zip`, up to 50 MB) becomes a new board with its history, `201 { id, name, head, revisions }` (signed in; counts toward the board limits and the create rate)'],
  ['GET /api/boards/:id', '`{ id, name, head, board, role, signInToEdit, owner: { name }, forkedFrom }`. `id` is the key you asked with; `role` is `owner`, `edit` or `view`; `signInToEdit` is true for a signed-out visitor on an edit link; `forkedFrom` is `{ key, name }` of the board this one was forked from, for its owner while they can still open that board by the link they forked it through, else `null`'],
  ['PUT /api/boards/:id', '`{ "board": <board json>, "baseRevision"?: n }`; `409` with `{ current }` if `baseRevision` is not the head. Only the owner\'s PUT can change the name; anyone else\'s keeps it'],
  ['PATCH /api/boards/:id', '`{ "name" }` renames (owner)'],
  ['DELETE /api/boards/:id', '`{ "confirm": <the board\'s exact name> }` deletes a board in the trash for good, with its history (owner)'],
  ['GET /api/boards/:id/check', 'findings and counts, as in the findings panel'],
  ['GET /api/boards/:id/bench', 'bench sheet (HTML); `?flip=lr` (default) or `tb` turns the bottom overviews over left-right or top-bottom, anything else is 422'],
  ['GET /api/boards/:id/download', 'the board as a `.wirebender.json` file'],
  ['GET /api/boards/:id/bundle', 'the board with its whole history as `<name>.wirebender.zip` (view; one at a time and 6 a minute with the other exports, per account or per address, then `429`)'],
  ['GET /api/boards/:id/thumbnail', 'an SVG of the top side, for the board lists'],
  ['GET /api/boards/:id/revisions', 'history'],
  ['GET /api/boards/:id/revisions/:n', 'the board as it was at revision `n`'],
  ['POST /api/boards/:id/revisions/:n/restore', 'makes revision `n` the board again, as a new revision'],
  ['POST /api/boards/:id/undo', 'undo the last change (`409` with `{ reason }` if there is nothing to undo)'],
  ['POST /api/boards/:id/redo', 'redo the last undone change (`409` with `{ reason }` if there is nothing to redo)'],
  ['POST /api/boards/:id/fork', 'a copy in your account, `{ id }` (signed in; on your own board it is a duplicate named `<name> (copy)`)'],
  ['POST /api/boards/:id/trash', 'moves the board to the trash, `{ trashedAt }` (owner)'],
  ['POST /api/boards/:id/untrash', 'brings it back, `{ trashedAt: null }` (owner)'],
  ['GET /api/boards/:id/sharing', '`{ visibility, hasPassword, link, canUsePremium }` (owner, public mode)'],
  ['PATCH /api/boards/:id/sharing', '`{ "visibility"?: "view"|"edit"|"private", "password"?: string|null }`; answers like the GET (owner, public mode)'],
  ['POST /api/boards/:id/sharing/regenerate', 'a new share link, `{ link }`; the old one stops working (owner, public mode)'],
  ['POST /api/links/:linkId/unlock', '`{ "password" }` opens a password link for this session (public mode; 5 wrong tries per address per 10 minutes, then `429`)'],
  ['GET /api/me', '`{ mode, user, providers }`: who is signed in (`id`, `name`, `avatar`, `isAdmin`, `isPremium`, `providers`, `deletedAt`), or `user: null`'],
  ['PATCH /api/me', '`{ "name" }` sets your display name (1 to 60 characters)'],
  ['DELETE /api/me', 'deletes your account, restorable for 30 days, and signs you out (public mode; `409` for the only admin)'],
  ['POST /api/me/restore', 'restores your deleted account after signing in again (public mode)'],
  ['GET /api/me/export', '`wirebender-boards-<date>.zip`, a bundle per board of yours, not the trashed ones (signed in; one at a time and 6 a minute, then `429`)'],
  ['POST /api/setup', '`{ "code" }` the setup code from the log, `{ ok, admin }` (public mode, until an admin exists; see First admin)'],
  ['GET /api/admin/users', 'every account (`id`, `name`, `providers`, `boards`, `isPremium`, `isAdmin`, `suspendedAt`, `deletedAt`, ...) (admin)'],
  ['PATCH /api/admin/users/:id', '`{ "premium"?, "suspended"?, "admin"? }`, each `true` or `false`; any other key is `422` (admin)'],
  ['GET /api/admin/export', '`wirebender-server-<date>.zip`, a bundle of every board of every account, trashed ones too, as `<owner>/<board>.wirebender.zip` (admin; not with a token)'],
  ['POST /api/pair/start', 'this computer only: a new pairing code, `{ code, expiresAt, url }` (local mode)'],
  ['POST /api/pair', '`{ "code", "name" }` pairs the calling device (the one call an unpaired device may make); sets its cookie (local mode)'],
  ['GET /api/devices', 'the paired devices (`id`, `name`, `createdAt`, `lastSeen`) (local mode)'],
  ['DELETE /api/devices/:id', 'unpairs a device (local mode)'],
  ['GET /api/devices/me', 'the calling device: `{ name, paired }` (local mode)'],
  ['GET /api/health', '`{ ok: true, mode }` without signing in, or `503 { ok: false }` when the database does not respond; `HEAD` works too']
]

// Backtick spans in the text become <code>.
const parts = (text: string) => text.split('`').map((t, i) => ({ t, code: i % 2 === 1 }))

const MCP_ADD = 'claude mcp add wirebender --env WIREBENDER_SERVER=http://localhost:3000 --env WIREBENDER_TOKEN=<your token> -- pnpm --silent --dir <path to wire-bender> wirebender mcp'
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-6 p-6">
    <header class="flex items-center gap-3">
      <NuxtLink
        to="/"
        aria-label="Boards"
      >
        <img
          src="/icon.svg"
          alt=""
          width="28"
          height="28"
        >
      </NuxtLink>
      <h1 class="text-xl font-semibold">
        API
      </h1>
    </header>

    <p class="text-sm text-muted">
      JSON over HTTP, for scripts and AI tools. Everything the app does with boards goes through these routes.
    </p>

    <p class="text-sm">
      The board JSON is described in the
      <a
        href="https://github.com/MathieuHalle/wire-bender/blob/main/docs/format/wirebender-1.md"
        class="underline"
        target="_blank"
        rel="noopener"
      >
        board file format
      </a>
      page, with a JSON Schema and examples.
    </p>

    <section class="space-y-2">
      <h2 class="text-base font-medium">
        Sign in with a token
      </h2>
      <p class="text-sm">
        Make a token on the
        <NuxtLink
          to="/account"
          class="underline"
        >
          account page
        </NuxtLink>
        and send it as a bearer token:
      </p>
      <pre class="overflow-x-auto rounded-md bg-elevated p-3 text-xs">curl -H "Authorization: Bearer $WIREBENDER_TOKEN" http://localhost:3000/api/boards</pre>
      <p class="text-sm">
        A token acts as you, on the boards you can already open, and its writes are marked with its name in the history.
        While a token works on a board, it shows there with a robot icon. Revoke it on the account page: it stops working
        at once, and its open live connections close.
      </p>
      <p class="text-sm">
        A token cannot do these. They answer <code>403</code> <code>Not allowed with a token.</code>
      </p>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li>delete your account or restore it</li>
        <li>delete a board, or change its sharing or share link</li>
        <li>make, list or revoke tokens</li>
        <li>admin and first-setup routes</li>
        <li>sign-in routes (<code>/auth/*</code>, <code>/api/_auth/*</code>)</li>
        <li>pairing and devices (<code>/api/pair*</code>, <code>/api/devices*</code>)</li>
        <li>unlock a password link</li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="text-base font-medium">
        Change a board
      </h2>
      <p class="text-sm">
        <code>GET /api/boards/:id</code> first, then <code>PUT /api/boards/:id</code> with <code>baseRevision</code> set
        to the <code>head</code> of that GET. Never send a <code>PUT</code> without it.
      </p>
      <p class="text-sm">
        A <code>409</code> means someone else changed the board in between (a tablet edit counts). GET the board again,
        redo your change on the new board, and <code>PUT</code> with the new <code>head</code>. Do not retry the old body.
      </p>
    </section>

    <section class="space-y-2">
      <h2 class="text-base font-medium">
        Errors
      </h2>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li><code>{ "error": "…" }</code> with the status: one message (<code>401</code>, <code>403</code>, <code>404</code>, <code>413</code>…).</li>
        <li><code>{ "errors": ["…"] }</code> with <code>422</code>: what is wrong with the data you sent, one line each.</li>
        <li><code>409</code> on a <code>PUT</code>: the board moved on. The body is <code>{ "current": n }</code>, the board's current <code>head</code>; GET the board again.</li>
        <li><code>409</code> on undo, redo or restore: <code>{ "reason": "…" }</code>, why it cannot be done.</li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="text-base font-medium">
        Routes
      </h2>
      <p class="text-sm text-muted">
        <code>:id</code> is a key: a board id (owner only) or a share link id. A role limits what a key can do:
        <code>PUT</code>, undo, redo and restore need edit; rename, trash, sharing and the link need the owner.
      </p>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b border-default">
              <th class="py-1 pr-3 font-medium">
                Route
              </th>
              <th class="py-1 font-medium">
                Does
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="[route, does] in ROUTES"
              :key="route"
              class="border-b border-default align-top"
            >
              <td class="py-1 pr-3">
                <code class="break-all">{{ route }}</code>
              </td>
              <td class="py-1">
                <template v-for="(p, i) in parts(does)">
                  <code
                    v-if="p.code"
                    :key="`c${i}`"
                    class="break-all"
                  >{{ p.t }}</code>
                  <template v-else>
                    {{ p.t }}
                  </template>
                </template>
              </td>
            </tr>
            <tr class="border-b border-default align-top">
              <td class="py-1 pr-3">
                <code class="break-all">GET, POST /api/tokens, DELETE /api/tokens/:id</code>
              </td>
              <td class="py-1">
                List, make and revoke your tokens. Browser session only: a token cannot call them.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="space-y-2">
      <h2 class="text-base font-medium">
        MCP server
      </h2>
      <p class="text-sm">
        An MCP server lets Claude and other AI tools read and edit your boards with a token. It reads
        <code>WIREBENDER_SERVER</code> (default <code>http://localhost:3000</code>) and <code>WIREBENDER_TOKEN</code>.
      </p>
      <pre class="overflow-x-auto rounded-md bg-elevated p-3 text-xs">{{ MCP_ADD }}</pre>
      <p class="text-sm text-muted">
        Keep <code>--silent</code>: without it pnpm prints a line before the server starts, and the client cannot read it.
        Add <code>--url</code> after <code>mcp</code>, or change <code>WIREBENDER_SERVER</code>, for a server on another port.
      </p>
    </section>
  </div>
</template>
