# CloudPG Console

A desktop psql front-end for [CloudNativePG](https://cloudnative-pg.io/) clusters, scoped to whatever your kubeconfig can see.

Pick a CNPG cluster from any context your kubeconfig knows about, pick a user, pick a database — CloudPG Console reads the credential secret, opens a port-forward to the cluster's primary pod, and drops you into a psql-style REPL with autocomplete and `\d`-style meta-commands. No shell juggling, no `kubectl port-forward` in a side terminal, no manually piecing together secrets.

## Why

If you operate Postgres on Kubernetes via CNPG across more than one cluster, the day-to-day shape of "open a quick psql against namespace X" is several steps and several windows: `kubectl config use-context`, `kubectl get secret … -o jsonpath`, base64 decode, `kubectl port-forward`, `psql -h localhost`, repeat for the next cluster. CloudPG Console folds all of that into a single tabbed UI, with a sidebar that already knows where every CNPG cluster lives and which postgres role goes with which database.

## Features

- **Cross-context inventory.** Discovers `postgresql.cnpg.io/v1 Cluster` and `Database` resources across every reachable kube context, unioned by kubernetes cluster (so the same `icecream` cluster reachable via two different contexts appears once, with the union of namespaces/users that any context can see).
- **One-click connect.** Reads the `cnpg-<cluster>-user-<name>` secret, opens a port-forward to `status.currentPrimary`, and connects a real `pg.Client`. If your first context lacks `pods/portforward` RBAC, it falls back to other contexts that can reach the same cluster.
- **End-to-end TLS.** The postgres connection does full TLS 1.3 validation against the cluster's CNPG-managed CA (`status.certificates.serverCASecret`) with hostname verification against the cert's SANs — not just an encrypted-but-unverified tunnel. Falls back to plaintext only when the cluster doesn't publish a CA. A lock badge in the sidebar, palette, and breadcrumb reflects the state at a glance.
- **psql-style REPL.** Real SQL goes to the live connection (transactions stay on one client). Client-side `\dt`, `\dv`, `\df`, `\dn`, `\du`, `\l`, `\d [schema.]name`, `\?`, `\timing`, `\x`, `\q` work off a cached `pg_catalog` introspection.
- **Bash-style tab completion.** Single-Tab completes uniquely or extends to the longest common prefix; double-Tab shows the list. Schema-qualified completion (`select * from public.u<tab>`) works.
- **Command palette.** ⌘K opens a fuzzy switcher across every (cluster, namespace, db, user) target with facet filters.
- **Graceful failure modes.** Expired AWS exec-auth creds, unreachable cluster endpoints, and `pods/portforward` RBAC denials are surfaced inline in the sidebar with the actual reason — no crash, no stack-trace popups.

## Requirements

- macOS, Linux, or Windows
- **Node 20 LTS** (Node 24+ silently breaks Electron's bundled `extract-zip` post-install step; use `nvm install 20 && nvm use 20`)
- A `~/.kube/config` (or `$KUBECONFIG`) with at least one context reaching a cluster running the CloudNativePG operator
- For each namespace you want to connect to: `get secrets` and `create pods/portforward` RBAC on your user

## Install & run

```sh
git clone https://github.com/<you>/cloudpg-console.git
cd cloudpg-console
make install      # npm install
make dev          # launch with --enable-logging
```

To build a distributable installer for your platform:

```sh
make package           # current platform → ./dist
make package-mac       # DMG + zip
make package-linux     # AppImage + .deb
make package-win       # NSIS + portable
```

## Usage

- **Sidebar** — k8s cluster → namespace → CNPG cluster → user → database. Click a database to open it in a tab.
- **⌘K** — command palette with facet filters (`k8s`, `ns`, `pg`, `user`, `db`).
- **⌘B** — toggle sidebar.
- **⌘T** — new tab (also opens the palette).
- **⌘W** — close active tab.
- **In the REPL** — type SQL terminated with `;` and hit Enter; `Shift+Enter` for newline; `Tab` to complete; `↑`/`↓` to walk command history; `\?` lists meta-commands.

## How it works

```
Renderer (React, esbuild-compiled)            Main (Electron)
─────────────────────────────────             ───────────────
src/backend.js  bootstrap() ─┐
src/sidebar.jsx              ├── window.cloudpg.k8s.*  ──┐
src/palette.jsx              │                           │ IPC
src/session.jsx ─────────────┴── window.cloudpg.pg.*  ───┤
                                                         │
                                                         ▼
                                              electron/main.js
                                                ├─ $PATH + $KUBECONFIG GUI-launch fix
                                                ├─ kubeconfig (multi-file safe)
                                                ├─ k8s API + CRD listing
                                                ├─ SelfSubjectAccessReview pre-flight
                                                ├─ PortForward to currentPrimary pod
                                                └─ pg.Client (per-session serialized queue)
```

JSX is pre-compiled to plain JS at build time (`make build` → esbuild) and React/ReactDOM are vendored from `node_modules` into `vendor/` — the renderer ships entirely local with no network on launch.

See [`CLAUDE.md`](./CLAUDE.md) for the in-depth architecture notes and [`TODO.md`](./TODO.md) for outstanding work (electron-builder code-signing, dev hot-reload).

## Troubleshooting

- **Sidebar stuck at "Loading kubernetes contexts…"** — the app surfaces a Diagnostics panel right where the spinner would have been. It shows `$KUBECONFIG`, the default path, each kubeconfig file's existence + size, and what shell probe (if any) was used to find `$KUBECONFIG`. The panel only appears when bootstrap has actually failed, not during normal loading.
- **Need to see console output from a packaged build?** Set `CLOUDPG_DEBUG=1` and packaged builds will auto-open DevTools. On macOS, `launchctl setenv CLOUDPG_DEBUG 1` makes it persist across Finder launches for the rest of the login session.

## Status

Functional. Wired against real CNPG clusters end-to-end; packaged builds work offline (no unpkg deps); postgres connections do full TLS 1.3 validation against the cluster's CA. Remaining production polish (signed installers, dev hot-reload) is tracked in `TODO.md`.
