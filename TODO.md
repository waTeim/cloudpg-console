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
make dev          # launch the Electron app
```

## Common targets

| Target                | What it does                              |
|-----------------------|-------------------------------------------|
| `make install`        | `npm install`                             |
| `make dev`            | run with logging                          |
| `make start`          | run                                       |
| `make package`        | build installer for the current platform  |
| `make package-mac`    | DMG + zip                                 |
| `make package-linux`  | AppImage + .deb                           |
| `make package-win`    | NSIS + portable                           |
| `make clean`          | remove `dist/`                            |
| `make distclean`      | remove `dist/` + `node_modules/`          |

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
│  envelope(fn)         catches & normalizes errors          │      │
│  loadKubeconfigSafe() merges multi-file kubeconfigs        │      │
│                                                            │      │
│  k8s:listContexts     ─── kc.getContexts()                 ◄──────┤
│  k8s:listNamespaces   ─── CoreV1Api.listNamespace          ◄──────┤
│  k8s:listCNPGClusters ─── CustomObjectsApi (clusters)      ◄──────┤
│  k8s:listCNPGDatabases ── CustomObjectsApi (databases)     ◄──────┤
│  k8s:listCNPGUsers    ─── filter secrets cnpg-<cluster>-*  ◄──────┤
│  k8s:readUserSecret   ─── base64-decode username/password  ◄──────┤
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

---

## Notes / gotchas

- **TLS.** The `pg.Client` is created with `ssl: false`. Fine for local
  dev where you trust the port-forward. For production, fetch the CA
  from the cluster's `<cluster>-ca` secret and use
  `ssl: { ca, rejectUnauthorized: true }`.
- **Multiple kubeconfigs with duplicate cluster names.** `loadFromDefault`
  throws on collisions; `loadKubeconfigSafe()` in `main.js` falls back
  to per-file load with name-deduplication (first wins).
- **CSP / remote scripts.** The HTML loads React + Babel from
  `unpkg.com` for development convenience. Before packaging for end
  users, either (a) vendor them into the repo or (b) use this
  project's "Save as standalone HTML" output as the file Electron
  loads.
- **Code-signing.** `electron-builder` reads signing creds from env
  (`CSC_LINK`, `CSC_KEY_PASSWORD` on mac/win); see their docs. No
  signing config currently lives in `package.json`.

---

## Repo layout

```
.
├── CloudPG Console.html      ← renderer entry point
├── styles.css
├── src/
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
├── package.json
├── Makefile
└── TODO.md                    you are here
```
