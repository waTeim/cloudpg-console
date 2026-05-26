# Building & running CloudPG Console

## Status

The repo currently contains a **complete UI prototype** wired against
mock data in `src/data.js`. The Electron shell (`electron/main.js` +
`electron/preload.js`) is also in place, with IPC handler **stubs**
ready to be filled in. To go from prototype to a real, talking-to-k8s
app you need to:

1. Install dependencies.
2. Uncomment the integration code in `electron/main.js`.
3. Swap the renderer's mock data layer for `window.cloudpg.*` IPC calls.

Steps 1 and 2 will already give you a runnable Electron app
showing the mock UI. Step 3 is the real-data part.

---

## Prerequisites

- Node 18+ and npm
- Platform toolchain for native modules (`pg` and `@kubernetes/client-node`
  both build cleanly with the prebuilds they ship, but `node-gyp` may need
  Python 3 + a C++ compiler on first install).
- A reachable kube context with the [CNPG operator](https://cloudnative-pg.io/)
  installed in at least one namespace.

## Quickstart

```sh
make install      # npm install
make dev          # launch the Electron app
```

You should see the existing UI with mock data. Real-data wiring is below.

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

## Wiring the real backend

### 1. Uncomment integration code in `electron/main.js`

The file has block-commented imports and handler bodies for:

- `k8s:listContexts`         — reads kubeconfig (honors `$KUBECONFIG`)
- `k8s:listNamespaces`       — `kubectl get ns`
- `k8s:listCNPGClusters`     — lists `postgresql.cnpg.io/v1 Cluster` CRs
- `k8s:listCNPGUsers`        — lists secrets matching `cnpg-<cluster>-user-*`
- `k8s:readUserSecret`       — base64-decodes username/password/dbname
- `pg:connect`               — opens a port-forward to the cluster's
                                `-rw` service and a `pg.Client` to it
- `pg:query`                 — executes SQL on the live client
- `pg:disconnect`            — tears down the client and the forward

Uncomment them and you have a working backend.

### 2. Replace the renderer's mock data layer

The renderer (the React app inside `CloudPG Console.html`) currently
builds its tree from `window.CONTEXTS` and `window.SCHEMAS` in
`src/data.js`. To go live:

1. Stop loading `src/data.js` from the HTML (`<script src="src/data.js">…`).
2. Replace the data the sidebar and palette read with async calls to
   `window.cloudpg.k8s.*`. Suggested approach:

   ```js
   // src/backend.js — a thin async data layer
   async function loadContexts() {
     const ctxs = await window.cloudpg.k8s.listContexts();
     // for each context, fetch ns / clusters / users on expand
     return ctxs;
   }
   ```

   Then convert the sidebar's static tree to lazy expansion — fetch
   namespaces only when a context is opened, clusters only when a
   namespace is opened, etc. (`useEffect` + a small cache.)

3. Replace `execSql` in `src/session.jsx` with a call to
   `window.cloudpg.pg.query(tab.id, sql)`. The mock `execSql` is
   structured to return the same shape the IPC handler returns
   (`{ rows, fields, command, rowCount }`), so the table renderer
   doesn't need to change.

4. Replace the connect log in `src/app.jsx#openSession` with a real
   `window.cloudpg.pg.connect(tab.id, { contextName, namespace,
   clusterName, user, password, database })` call. Read the password
   from `window.cloudpg.k8s.readUserSecret(...)` right before connect
   so it never lands in renderer-side state.

A single `src/backend.js` module that exposes the same surface as
`window.CONTEXTS` + `execSql` (but async) is the cleanest path — then
the sidebar, palette, and session each take small edits to `await`.

### 3. Schema browser / autocomplete

Right now autocomplete and `\dt` use `window.SCHEMAS[db]`. After
connecting, populate that lazily by running
`SELECT … FROM pg_catalog.pg_class / pg_attribute …` and caching the
result keyed by `(context, namespace, cluster, db)`. The
`getAutocompleteSuggestions` helper in `src/session.jsx` already
expects the same shape, so caching the result of one introspection
query per database is enough.

---

## Notes / gotchas

- **Port-forwarding.** `@kubernetes/client-node`'s `PortForward` operates
  on a **pod**, not a service. The skeleton in `electron/main.js` shows
  where you need to resolve `<cluster>-rw` → current primary pod (either
  via the Endpoints API or by reading `Cluster.status.currentPrimary`).
- **TLS.** Set `ssl: { rejectUnauthorized: false }` in the `pg.Client`
  options only for local dev. For production, fetch the CA from the
  cluster's `<cluster>-ca` secret and pin it.
- **CSP / remote scripts.** The HTML loads React + Babel from
  `unpkg.com` for development convenience. Before packaging for end
  users, either (a) vendor them into the repo or (b) use this
  project's "Save as standalone HTML" output as the file Electron
  loads. The mock UI works either way.
- **Code-signing.** `electron-builder` reads signing creds from env
  (`CSC_LINK`, `CSC_KEY_PASSWORD` on mac/win); see their docs.

---

## Repo layout

```
.
├── CloudPG Console.html      ← renderer entry point
├── styles.css
├── src/
│   ├── app.jsx                top-level + tab/session orchestration
│   ├── sidebar.jsx            kubernetes tree
│   ├── session.jsx            psql REPL + result rendering
│   ├── palette.jsx            ⌘K switcher with facet filters
│   ├── icons.jsx
│   ├── tweaks-panel.jsx       theme / sidebar width controls
│   └── data.js                ⚠ mock data — replace per "Wiring" above
├── electron/
│   ├── main.js                main process + IPC handler stubs
│   └── preload.js             window.cloudpg bridge
├── package.json
├── Makefile
└── BUILD.md                   you are here
```
