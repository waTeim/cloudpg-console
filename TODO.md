# Building & running CloudPG Console

## Status

The app is **wired against real kubernetes / CNPG clusters** end-to-end:

- The Electron main process (`electron/main.js`) talks to kube via
  `@kubernetes/client-node`, enumerates CNPG `Cluster` and `Database`
  custom resources, reads user-credential secrets, opens a port-forward
  to the primary pod, and runs SQL through a `pg.Client`.
- The renderer (`CloudPG Console.html` + `src/*.jsx`) drives a sidebar /
  command palette / psql-style REPL from that data, with live schema
  introspection feeding autocomplete and `\d` / `\dt` meta-commands.

The IPC bridge in `electron/preload.js` exposes the surface as
`window.cloudpg.k8s.*` and `window.cloudpg.pg.*`. There is no mock data
layer anymore — `src/backend.js` is the async data module that wraps the
IPC calls.

## Prerequisites

- **Node 20 LTS.** Newer Node (24+) breaks the bundled `extract-zip`
  used by Electron's post-install step, leaving you with no Electron
  binary. Use `nvm install 20 && nvm use 20` if you see install fail.
- Platform toolchain for native modules. `pg` and `@kubernetes/client-node`
  both build cleanly with the prebuilds they ship, but `node-gyp` may
  need Python 3 + a C++ compiler on first install.
- A reachable kube context with the [CNPG operator](https://cloudnative-pg.io/)
  installed in at least one namespace, plus your user's RBAC granting
  `create pods/portforward` and `get secrets` in the namespace(s) you
  want to connect to.

## Quickstart

```sh
make install      # npm install
make dev          # build renderer, launch the Electron app
```

`make dev` runs the renderer build first (~10ms with esbuild). The build
compiles `src/*.jsx` → `out/*.js` (classic JSX transform, minified) and
vendors React + ReactDOM production UMD into `vendor/`. The Electron
renderer loads only local files — no network on launch.

## Common targets

| Target                | What it does                                       |
|-----------------------|----------------------------------------------------|
| `make install`        | `npm install`                                      |
| `make build`          | compile JSX → `out/`, vendor React → `vendor/`     |
| `make dev`            | build then run with logging                        |
| `make start`          | build then run                                     |
| `make package`        | build then create installer for the current platform |
| `make package-mac`    | DMG + zip                                          |
| `make package-linux`  | AppImage + .deb                                    |
| `make package-win`    | NSIS + portable                                    |
| `make clean`          | remove `dist/`, `out/`, `vendor/`                  |
| `make distclean`      | clean + `node_modules/`                            |

Output of `make package` lands in `./dist`.

---

## Architecture

### Data flow

```
┌─ renderer (React) ────────────────────────────────────────────────┐
│  src/backend.js   bootstrap()  ─┐                                 │
│  src/sidebar.jsx  Sidebar       ├── window.cloudpg.k8s.*  ─┐      │
│  src/palette.jsx  CommandPalette│                          │      │
│  src/session.jsx  Session  ─────┴── window.cloudpg.pg.*  ──┤      │
└────────────────────────────────────────────────────────────┼──────┘
                                                             │ IPC
┌─ main (electron/main.js) ──────────────────────────────────┼──────┐
│  startup:                                                  │      │
│   augmentPathForGuiLaunch()  add /opt/homebrew/bin etc.    │      │
│   probeKubeconfigFromShell() narrow $KUBECONFIG probe      │      │
│                                                            │      │
│  envelope(fn)         catches & normalizes errors          │      │
│  loadKubeconfigSafe() merges multi-file kubeconfigs        │      │
│                                                            │      │
│  k8s:listContexts     ─── kc.getContexts()                 ◄──────┤
│  k8s:listNamespaces   ─── CoreV1Api.listNamespace          ◄──────┤
│  k8s:listCNPGClusters ─── CustomObjectsApi (clusters)      ◄──────┤
│  k8s:listCNPGDatabases ── CustomObjectsApi (databases)     ◄──────┤
│  k8s:listCNPGUsers    ─── filter secrets cnpg-<cluster>-*  ◄──────┤
│  k8s:readUserSecret   ─── base64-decode username/password  ◄──────┤
│  k8s:diagnose         ─── kubeconfig probe & file snapshot ◄──────┤
│  pg:connect           ─┬─ SSAR pre-flight (portforward?)   ◄──────┤
│                        ├─ PortForward → primary pod        │      │
│                        └─ new pg.Client                    │      │
│  pg:query             ─── per-session serialized queue     ◄──────┤
│  pg:disconnect        ─── close client + server            ◄──────┘
└──────────────────────────────────────────────────────────────────-┘
```

### Bootstrap & multi-context unioning

`backend.bootstrap()` groups kube contexts by their **cluster** (not by
context name). Two contexts pointing at the same `icecream` cluster
become one entry in the sidebar, with the union of their reachable
namespaces / CNPG clusters / users. Each level carries a `contextNames`
array recording which contexts can reach it; the connect path uses that
to fall back through contexts if one lacks `pods/portforward` RBAC.

### Per-session query ordering

`pg.Client` rejects concurrent `client.query()` calls (deprecated in
pg@8, removed in pg@9). `pg:query` runs each query through a per-session
promise chain (`chain(s, fn)` in `electron/main.js`), so parallel
introspection queries from the renderer serialize transparently *and*
multi-statement transactions stay on the same connection.

### Database / user pairing

The sidebar shows a CNPG `Database` CR (`postgresql.cnpg.io/v1`) under
the user whose name matches `spec.owner`. Databases with no `owner` (or
clusters with no Database CR — only a bootstrap initdb seed) fall back
to showing under every user.

### GUI launch environment

macOS/Linux GUI launches (Finder double-click, dock, AppImage) start
with a minimal env: `$PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`, and
shell-set variables like `$KUBECONFIG` aren't inherited. Two narrow
fixups at startup, in `electron/main.js`:

- `augmentPathForGuiLaunch()` prepends standard package-manager dirs to
  `$PATH` (`/opt/homebrew/{bin,sbin}`, `/usr/local/{bin,sbin}`,
  `~/.local/bin`) — deterministic, no probing. Lets exec-auth providers
  (`aws`, `gcloud`, `kubectl-oidc_login`) be found.
- `probeKubeconfigFromShell()` narrowly extracts **only** `$KUBECONFIG`
  from the user's interactive+login shell when our env doesn't already
  have it. Finds the actual login shell via `dscl . -read /Users/$USER
  UserShell` (macOS) or `getent passwd $USER` (Linux), then falls back
  to `$SHELL`, `/bin/bash`, `/bin/zsh`, `/bin/sh`. Stops at the first
  candidate whose `-ilc 'printf …$KUBECONFIG'` returns a non-empty
  value. We deliberately don't inherit anything else from the shell —
  the broad "shell-env app" pattern was rejected, with `$KUBECONFIG`
  carved out as the one variable that has no in-app alternative.

### Diagnostics surface

`k8s:diagnose` returns a snapshot of the kubeconfig discovery state:
`$KUBECONFIG` value, default path, per-file existence/readability/size,
context count, kube load error, and the full `kubeconfigProbe` state
(per-shell attempts with stdout/stderr/value/error/ms). The renderer's
`EmptyState` calls it **only** when bootstrap has actually failed —
`bootstrapState === 'error'` or `'loaded' && ctxCount === 0`. During
normal loading, the spinner copy is shown alone. Once bootstrap
succeeds with contexts, the diag panel never appears.

Set `CLOUDPG_DEBUG=1` (e.g. `launchctl setenv CLOUDPG_DEBUG 1` on
macOS) and packaged builds auto-open DevTools — useful when
stdout/stderr go nowhere visible.

---

## Notes / gotchas

- **Multiple kubeconfigs with duplicate cluster names.** `loadFromDefault`
  throws on collisions; `loadKubeconfigSafe()` in `main.js` falls back
  to per-file load with name-deduplication (first wins).
- **Code-signing & notarization (macOS).** Scaffolding is in place but
  inactive. When you're ready, the steps are documented inline in
  `electron-builder.yml` under the `mac:` block — short version:
  1. Get a Developer ID Application cert from Apple, export as `.p12`,
     `export CSC_LINK=/path/to/cert.p12 CSC_KEY_PASSWORD='...'`.
  2. Generate an app-specific password for your Apple ID at
     <https://appleid.apple.com>, then `export APPLE_ID='you@…'
     APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
     APPLE_TEAM_ID='XXXXXXXXXX'`.
  3. In `electron-builder.yml`, uncomment the four `# hardenedRuntime`,
     `# entitlements`, `# entitlementsInherit`, `# notarize` lines.
  4. `make package-mac` will now sign and notarize.

  The entitlements file is already at `build/entitlements.mac.plist`
  (JIT, network client+server, environment vars for V8 + Electron
  helpers). Don't add more entitlements than you need — notarization
  reviews them.
- **Code-signing (Windows).** Set `CSC_LINK` / `CSC_KEY_PASSWORD` to a
  Windows codesigning cert (`.p12` or `.pfx`) and re-run
  `make package-win`. EV cert avoids SmartScreen ramp-up.
- **`make watch` (dev hot-reload).** `make dev` runs the build once
  then launches Electron — edits to `src/*.jsx` require restarting.
  esbuild has a watch mode that incrementally re-emits on change; add
  a `build:watch` script (`esbuild ... --watch`) and a parallel
  Electron `--enable-logging` invocation, plus an Electron-side
  `webContents.reload()` triggered by a file watcher (or just use
  `electron-reloader`).
- **Titlebar min/max/close buttons (Linux/Windows).** The three
  `.os-provided` buttons in `<Titlebar>` (`src/app.jsx`) render but have
  no `onClick`. They're hidden on macOS (`[data-platform="darwin"]`
  rule in `styles.css`) since the traffic lights cover the same
  functionality, but on Linux/Windows they need to be wired through
  Electron. Plan: add `win:minimize` / `win:maximize` (toggle
  `isMaximized() ? unmaximize() : maximize()`) / `win:close` IPC
  handlers in `electron/main.js`, expose them on `window.cloudpg.win.*`
  via `electron/preload.js`, and hook the buttons' `onClick`.

---

## Repo layout

```
.
├── CloudPG Console.html      ← renderer entry point (loads out/ + vendor/)
├── styles.css
├── src/                       source (committed)
│   ├── app.jsx                top-level + tab/session orchestration
│   ├── sidebar.jsx            kubernetes tree (k8s cluster → ns → pg → user → db)
│   ├── session.jsx            psql REPL + result rendering
│   ├── palette.jsx            ⌘K switcher with facet filters
│   ├── icons.jsx
│   ├── tweaks-panel.jsx       theme / sidebar width controls
│   └── backend.js             window.backend.bootstrap() / introspect()
├── electron/
│   ├── main.js                main process + IPC handlers
│   └── preload.js             window.cloudpg bridge
├── scripts/
│   └── build.js               esbuild driver (JSX → JS, vendor React)
├── build/                     electron-builder resource dir
│   └── entitlements.mac.plist signing/notarization (currently inactive)
├── out/                       generated, gitignored — compiled renderer JS
├── vendor/                    generated, gitignored — React UMD bundles
├── package.json               npm scripts + deps
├── electron-builder.yml       packaging config (separate so YAML # comments work)
├── Makefile
├── README.md                  github-facing description + quickstart
├── CLAUDE.md                  guidance for Claude Code sessions
└── TODO.md                    you are here
```
