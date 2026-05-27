# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Electron desktop app that gives you a psql-style REPL against CloudNativePG (`postgresql.cnpg.io/v1`) clusters discovered through your local kubeconfig. The main process speaks kube + opens a port-forward to the primary pod; the renderer is a React UI (sidebar tree, ⌘K palette, REPL tabs).

## Build & run

```sh
make install      # npm install
make dev          # electron . --enable-logging
make start        # electron .
make package      # electron-builder for current platform
make package-mac  # also: -linux, -win
make clean        # rm -rf dist
make distclean    # also wipes node_modules
```

**Node 20 LTS is required.** Node 24+ breaks `extract-zip` in Electron's post-install, leaving you with no binary in `node_modules/electron/dist`. Use `nvm install 20 && nvm use 20`. No test runner is configured.

There's no bundler: the renderer loads React + Babel from `unpkg.com` and Babel compiles `.jsx` in the browser. To syntax-check JSX outside the app:

```sh
npm i --no-save @babel/core @babel/preset-react
node -e "require('@babel/core').transformSync(require('fs').readFileSync('src/session.jsx','utf8'), { presets: ['@babel/preset-react'] })"
```

## Architecture

### Two processes, one IPC bridge

- **Main** (`electron/main.js`) wraps every k8s/pg call in `envelope(fn)`, which catches and normalizes errors into `{ ok, data | error }`. This is what stops Electron from auto-logging stack traces when a context's creds expire or its cluster is unreachable.
- **Preload** (`electron/preload.js`) exposes the surface as `window.cloudpg.k8s.*` and `window.cloudpg.pg.*`. Every method here is 1:1 with an `ipcMain.handle()` in `main.js`.
- **Renderer** (`CloudPG Console.html` + `src/*.jsx`) consumes those calls through `src/backend.js`, which is the *only* async data module — no other renderer file should call `window.cloudpg.*` for inventory.

### Renderer scripts are loaded via `<script>` tags, not modules

This has a non-obvious consequence: a top-level `function foo() {}` in any `.jsx` file is also `window.foo`. Patterns to know:

- Files publish their exports by assigning to `window.*` at the bottom (`window.Session = Session`, `window.flattenTargets = flattenTargets`, etc.).
- **Never do** `window.foo = (x) => foo(x)` — the arrow body references `window.foo` (which is now the arrow itself) and infinite-recurses. Use direct assignment `window.foo = foo`.
- `window.SCHEMAS`, `window.PHASE_VARIANT`, `window.SQL_KEYWORDS`, `window.SQL_FUNCTIONS`, `window.PSQL_META` live in `src/backend.js` and are read across files.

### Bootstrap unions contexts by kubernetes cluster

`backend.bootstrap()` groups kube contexts by their `cluster` (not by context name), so two contexts pointing at the same `icecream` cluster appear as one entry. Each level (cluster / namespace / cnpg-cluster / user) carries a `contextNames: []` array recording which kube contexts can reach it. `doConnect` in `src/app.jsx` walks those alternatives — if the first context lacks `pods/portforward` RBAC, it tries the next, so a user reachable via *any* context succeeds.

If you change the bootstrap shape, the consumers that need updating are `src/sidebar.jsx` (iteration + `onOpenSession` target), `src/palette.jsx` (`flattenTargets`), and `doConnect` in `src/app.jsx`.

### Connection path: SSAR → port-forward → pg.Client

`pg:connect` in `main.js`:
1. `canPortForward()` does a `SelfSubjectAccessReview` for `pods/portforward` in the target namespace and returns `{ok:false, error}` immediately on denial — this is what prevents the unhandled WebSocket-403 that would otherwise crash the main process.
2. `openPortForward()` reads `cluster.status.currentPrimary`, opens a `net.createServer` that pipes each TCP socket through `k8s.PortForward`, and attaches *defensive* `error` listeners on the socket, the WS, and the listening server. The `@kubernetes/client-node` `once`-style error handler is unreliable across the WebSocket's two lifecycle events; our listeners catch the leftover.
3. A `pg.Client` connects to `127.0.0.1:<localPort>` with `ssl: false`.

There's also a process-level `uncaughtException` / `unhandledRejection` handler as a final backstop.

### Per-session query serialization

`pg.Client` rejects concurrent `client.query()` (deprecated in pg@8, removed in pg@9). `pg:query` runs through `chain(s, fn)` — a per-session promise chain — so the renderer's parallel introspection queries (`Promise.all([tables, views, fns])` in `backend.introspect`) serialize transparently, and multi-statement transactions (`BEGIN; …; COMMIT`) stay on the same connection.

### Database / user pairing

`backend.bootstrap()` layers `Database` CRs (`postgresql.cnpg.io/v1`) on top of each cluster, keyed by `spec.cluster.name`. The CR's `spec.owner` (the postgres role that owns the DB) is what `src/sidebar.jsx` and `src/palette.jsx` use to filter which databases appear under which user. A DB with no owner — or a cluster with no Database CR at all (only the bootstrap initdb seed) — falls back to showing under every user. CR entries always override the bootstrap-spec seed on a name collision so the post-bootstrap owner (which actually matches a connectable role) wins.

### REPL: tab-driven completion

`src/session.jsx` does *not* auto-popup suggestions as you type. Completion is Tab-driven (bash-like):

- One Tab + 1 match → silently inserts it.
- One Tab + N matches with a longer common prefix → extends the typed text to the prefix.
- Two Tabs within 500ms (`lastTabRef`) + N matches → opens the popup.
- Inside the popup: `↑↓` navigates (clamped, no wrap), `Tab` or `Enter` accepts, `Esc` closes.

`commonPrefix` runs on the **full** suggestion list (not the displayed slice) — truncating before computing the prefix used to cut off entries like `users` when many `user_*` siblings preceded it alphabetically, yielding a wrong `"user_"` instead of `"user"`.

Schema-qualified completion: when the fragment contains a `.` (e.g. `public.u`), the schema name scopes the lookup and the replacement range begins *after* the dot so the suggestion doesn't re-type the schema.

`run()` only calls `execMeta(sql, ctx)` for `\`-prefixed input (the client-side meta-command handler). Everything else goes through `window.cloudpg.pg.query(tab.id, sql)`.

## Outstanding non-blocking work

See `TODO.md` for the architecture overview and the remaining cleanup items (TLS via cluster CA secret, vendoring React/Babel for packaging, electron-builder code-signing config).
