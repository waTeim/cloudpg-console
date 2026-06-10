# Repository Guidelines

## Project Structure & Module Organization

CloudPG Console is an Electron desktop app for CloudNativePG access. The main process lives in `electron/main.js`, with the secure renderer bridge in `electron/preload.js`. Renderer source is in `src/`: JSX UI files (`app.jsx`, `sidebar.jsx`, `session.jsx`, `palette.jsx`, `tweaks-panel.jsx`, `icons.jsx`) plus `backend.js` for renderer-side async data access. `CloudPG Console.html` loads compiled scripts directly, so script order matters. Build tooling is in `scripts/build.js`; packaging config is in `electron-builder.yml` and `build/`. Generated outputs are `out/`, `vendor/`, and `dist/`.

## Build, Test, and Development Commands

Use Node 20 LTS; newer Node versions may break Electron installation.

- `make install` / `npm install`: install dependencies.
- `make build` / `npm run build`: compile `src/*.jsx` to `out/*.js` and copy React UMD files to `vendor/`.
- `make dev` / `npm run dev`: build, then launch Electron with logging.
- `make start` / `npm start`: build, then launch normally.
- `make package`: build installers for the current platform into `dist/`.
- `make clean`: remove generated `dist`, `out`, and `vendor`.

## Coding Style & Naming Conventions

JavaScript uses two-space indentation, semicolons, `const`/`let`, and camelCase for variables/functions. React components use PascalCase. Keep renderer exports explicit via `window.Name = Name`; avoid wrapper assignments that can recurse in non-module script loading. Keep IPC calls centralized through `src/backend.js` unless changing the preload/main API surface. Prefer small, direct functions over new abstractions unless they reduce real duplication.

## Testing Guidelines

No automated test runner is currently configured. Before submitting changes, run `make build` at minimum. For behavior touching Electron, kube discovery, port-forwarding, TLS, or the REPL, run `make dev` and verify the affected flow manually against an appropriate kubeconfig. If adding tests, document the runner in `package.json` and update this guide.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Support TLS connection to cluster endpoints` or concise lowercase notes like `packaging`. Keep the first line focused and under about 72 characters. Pull requests should include a short problem/solution summary, manual verification steps, linked issues when relevant, and screenshots or screen recordings for UI changes. Call out configuration or RBAC assumptions for Kubernetes-related work.

## Security & Configuration Tips

Do not commit kubeconfigs, secrets, certificates, packaged credentials, or local diagnostic logs. The app relies on `~/.kube/config` or `$KUBECONFIG`; keep environment probing narrow and avoid broad shell environment imports. Preserve TLS verification behavior unless the change explicitly addresses a verified compatibility issue.
