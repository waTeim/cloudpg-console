# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Electron desktop app that gives you a psql-style REPL against CloudNativePG (`postgresql.cnpg.io/v1`) clusters discovered through your local kubeconfig. The main process speaks kube + opens a port-forward to the primary pod; the renderer is a React UI (sidebar tree, ⌘K palette, REPL tabs).

## Build & run

```sh
make install      # npm install
make build        # esbuild src/*.jsx → out/*.js, vendor React → vendor/
make dev          # build, then electron . --enable-logging
make start        # build, then electron .
make package      # build, then electron-builder for current platform
make package-mac  # also: -linux, -win
make clean        # rm -rf dist out vendor
make distclean    # also wipes node_modules
```

**Node 20 LTS is required.** Node 24+ breaks `extract-zip` in Electron's post-install, leaving you with no binary in `node_modules/electron/dist`. Use `nvm install 20 && nvm use 20`. No test runner is configured.

### Build pipeline

`scripts/build.js` is an esbuild driver, ~30 lines. For each `src/*.jsx` it runs the classic JSX transform (`React.createElement` / `React.Fragment` — keeps the existing "React is a global" convention), minifies, drops inline sourcemaps, writes to `out/*.js`. Copies `src/backend.js` through unchanged. Copies `node_modules/react{,-dom}/umd/*.production.min.js` into `vendor/`. Runs in ~10ms.

`CloudPG Console.html` references `vendor/react*.js` and `out/*.js` directly — no Babel, no unpkg, no network on launch. Load order matters because each script publishes to `window.*` and later files depend on earlier ones (`backend → tweaks → icons → sidebar → session → palette → app`).

`out/` and `vendor/` are gitignored. `make clean` removes them. Editing a `.jsx` requires `make build` again — no watch mode currently (tracked in `TODO.md`).

To syntax-check JSX outside the pipeline:

```sh
npm i --no-save @babel/core @babel/preset-react
node -e "require('@babel/core').transformSync(require('fs').readFileSync('src/session.jsx','utf8'), { presets: ['@babel/preset-react'] })"
```

### Packaging

electron-builder config lives in **`electron-builder.yml`** (separate from `package.json` so YAML `#` comments survive — electron-builder 25 rejects unknown keys, so the JSON `"//"` pseudo-comment trick doesn't work). The `mac:` block has signing scaffolding commented out with inline instructions for when an Apple Developer account is available. `build/entitlements.mac.plist` is already in place.

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

### GUI launch environment handling

macOS/Linux Finder/dock launches start the process with a minimal env — `$PATH` is `/usr/bin:/bin:/usr/sbin:/sbin` and shell-set vars like `$KUBECONFIG` are *not* inherited. The app would otherwise stare at "Loading contexts…" forever because exec-auth providers (`aws`, `gcloud`, `kubectl-oidc_login`) and the user's actual kubeconfig list are invisible. `electron/main.js` does two narrow, deterministic things at startup:

- **`augmentPathForGuiLaunch()`** — prepends standard package-manager dirs to `$PATH` (`/opt/homebrew/{bin,sbin}`, `/usr/local/{bin,sbin}`, `~/.local/bin`). No probing, no shell exec. Runs only when `app.isPackaged && process.platform !== 'win32'`.
- **`probeKubeconfigFromShell()`** — narrowly extracts *only* `$KUBECONFIG` from the user's interactive+login shell, when our env doesn't already have it. Looks up the user's configured login shell via `dscl . -read /Users/$USER UserShell` on macOS / `getent passwd $USER` on Linux, then falls back to `$SHELL`, `/bin/bash`, `/bin/zsh`, `/bin/sh` — dedup'd, only if the binary exists. Each candidate is run with `-ilc 'printf "%s:%s\n" "MARK" "$KUBECONFIG"'` and matched with a multiline regex against the marker; first non-empty value wins. State is kept in the `kubeconfigProbe` object so the diagnose IPC can show what happened.

Critical scope: the shell probe extracts **only** `$KUBECONFIG`. Earlier iterations of this code pulled HOME/USER/PATH/AWS_*/etc.; that was rejected as "too broad, app should be self-contained". The narrow exception for `$KUBECONFIG` is defensible because it's the one variable that has no in-app alternative — many users define their multi-file kubeconfig list only in their shell rc.

### Diagnostics surface

`k8s:diagnose` IPC returns a snapshot of: `$KUBECONFIG` value, default path, per-file existence/size/readability, context count, kube load error, and the full `kubeconfigProbe` state (source, login shell, each per-shell attempt's shell/stdout/stderr/value/error/ms). `EmptyState` in `src/app.jsx` fetches this **only** when bootstrap has actually failed — `bootstrapState === 'error'` or `'loaded' && ctxCount === 0`. During the normal loading window it just shows a spinner. The intent is "appear only when something needs fixing".

`bootstrapState` (`'loading' | 'loaded' | 'error'`) is tracked alongside `contexts` in `App` and threaded through to `EmptyState`. When you add a new failure mode for bootstrap, set the state accordingly so the diag panel can decide whether to surface itself.

Set the env var `CLOUDPG_DEBUG=1` (e.g. `launchctl setenv CLOUDPG_DEBUG 1` on macOS) and packaged builds auto-open DevTools — useful when stdout/stderr go nowhere visible.

### Bootstrap unions contexts by kubernetes cluster

`backend.bootstrap()` groups kube contexts by their `cluster` (not by context name), so two contexts pointing at the same `icecream` cluster appear as one entry. Each level (cluster / namespace / cnpg-cluster / user) carries a `contextNames: []` array recording which kube contexts can reach it. `doConnect` in `src/app.jsx` walks those alternatives — if the first context lacks `pods/portforward` RBAC, it tries the next, so a user reachable via *any* context succeeds.

If you change the bootstrap shape, the consumers that need updating are `src/sidebar.jsx` (iteration + `onOpenSession` target), `src/palette.jsx` (`flattenTargets`), and `doConnect` in `src/app.jsx`.

### Connection path: SSAR → port-forward → pg.Client (TLS)

`pg:connect` in `main.js`:
1. `canPortForward()` does a `SelfSubjectAccessReview` for `pods/portforward` in the target namespace and returns `{ok:false, error}` immediately on denial — this is what prevents the unhandled WebSocket-403 that would otherwise crash the main process.
2. `getClusterTlsInfo()` fetches the CNPG `Cluster` CR once and extracts `status.currentPrimary` (for port-forwarding), `status.certificates.serverCASecret` (the CA), and `status.certificates.serverAltDNSNames` (the SANs the server cert was issued for). One CR fetch covers both port-forward and TLS setup.
3. `openPortForward()` opens a `net.createServer` that pipes each TCP socket through `k8s.PortForward`, with *defensive* `error` listeners on the socket, the WS, and the listening server. The `@kubernetes/client-node` `once`-style error handler is unreliable across the WebSocket's two lifecycle events; our listeners catch the leftover.
4. `readServerCA()` base64-decodes `ca.crt` from the secret.
5. `pg.Client` connects to `127.0.0.1:<localPort>` with `ssl: { ca, servername: serverAltNames[0], rejectUnauthorized: true }`. The `servername` override is necessary because the cert's SANs are the in-cluster service DNS names (e.g. `postgres-cluster-rw`), not `127.0.0.1`; we tell node:tls to validate as if connecting to that host. If the CA or SAN list is missing (non-CNPG cluster, partially-configured CR), we fall back to `ssl: false` and record the reason. The response's `info.tls` field reports `"verified (CA=…, servername=…)"` or `"disabled (…)"` so the renderer can render the breadcrumb's TLS lock badge in the correct color.

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

See `TODO.md`. Current items: code-signing (mac + win), `make watch` for dev hot-reload, wiring the min/max/close titlebar buttons on Linux/Windows.
