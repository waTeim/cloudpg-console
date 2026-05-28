// CloudPG Console — Electron main process

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const os   = require('os');
const net  = require('net');

const k8s = require('@kubernetes/client-node');
const { Client } = require('pg');

let win;

// macOS/Linux GUI launch (double-click .app, dock click, AppImage) starts
// the process with a minimal $PATH:
//   /usr/bin:/bin:/usr/sbin:/sbin
// — none of /usr/local/bin, /opt/homebrew/bin, or ~/.local/bin. That
// breaks kubeconfig exec-auth providers (aws, gcloud, kubectl-oidc_login)
// the kubernetes client spawns to refresh credentials. Symptom: sidebar
// stuck at "Loading contexts…" because every probe errors out.
//
// We deliberately do NOT probe the user's shell or inherit shell env —
// the app should be self-contained. We just prepend the standard system
// tool locations to $PATH so binaries that exist at conventional
// package-manager paths can be found.
//
// Kubeconfig discovery itself needs no help: @kubernetes/client-node's
// loadFromDefault() honors $KUBECONFIG if set in our environment, else
// falls back to ~/.kube/config. We do not attempt to read a $KUBECONFIG
// the user only set in their shell rc files — that would require shell
// probing. Users with non-standard kubeconfig paths should either point
// $KUBECONFIG via `launchctl setenv KUBECONFIG ...` (macOS) or symlink
// ~/.kube/config to their preferred file.
function augmentPathForGuiLaunch() {
  if (process.platform === 'win32') return;  // Win32 inherits the user's env
  if (!app.isPackaged) return;                // dev launches inherit the shell's
  const extras = [
    '/opt/homebrew/bin',  // macOS Homebrew (arm64)
    '/opt/homebrew/sbin',
    '/usr/local/bin',     // macOS Homebrew (x64), common /usr/local installs
    '/usr/local/sbin',
    `${process.env.HOME || ''}/.local/bin`,  // pipx, cargo, asdf shims
  ].filter(Boolean);
  process.env.PATH = `${extras.join(':')}:${process.env.PATH || ''}`;
}
augmentPathForGuiLaunch();

// $KUBECONFIG is the one piece of shell-set state the app legitimately
// needs and has no in-app alternative for — many users colon-join
// multiple files via $KUBECONFIG in their shell rc and that's their
// source of truth for which clusters exist. GUI launches on macOS/Linux
// don't inherit shell env, so we'd otherwise see only ~/.kube/config
// (often an empty stub) and report "0 contexts".
//
// Narrow probe: fork the user's shell ONCE, echo only $KUBECONFIG, copy
// it into process.env. We deliberately don't inherit PATH/HOME/AWS/etc.
// from the shell — those are the broad "shell-env app" trap.
//
// Skips when KUBECONFIG is already in our env (terminal launch,
// `launchctl setenv`, Info.plist LSEnvironment, etc.), on Windows
// (Win32 GUI launches inherit the user env), and in dev (`npm run dev`
// already has the shell's env).
// Probe state, exposed in the k8s:diagnose IPC so the user can see
// whether we tried, which shell we used, what came back, and why.
const kubeconfigProbe = {
  source:     null,   // 'env' | 'shell' | 'default' | 'error' | 'skipped'
  reason:     '',     // human-readable explanation
  shell:      null,   // shell that yielded the value (if any)
  attempts:   [],     // per-shell { shell, stdout, stderr, value, error, ms }
  durationMs: null,
};

// Look up the user's configured login shell from the OS identity store
// (macOS dscl, Linux nss/getent). More authoritative than $SHELL because
// it doesn't depend on what env launchd or a terminal happened to set.
// Returns null on lookup failure — caller falls back to $SHELL.
function findLoginShell() {
  const { spawnSync } = require('child_process');
  const user = process.env.USER || os.userInfo().username;
  if (!user) return null;
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('dscl', ['.', '-read', `/Users/${user}`, 'UserShell'],
        { encoding: 'utf8', timeout: 1000 });
      const m = (r.stdout || '').match(/UserShell:\s*(\S+)/);
      return m ? m[1].trim() : null;
    }
    if (process.platform === 'linux') {
      const r = spawnSync('getent', ['passwd', user],
        { encoding: 'utf8', timeout: 1000 });
      const parts = (r.stdout || '').trim().split(':');
      // /etc/passwd line: name:passwd:uid:gid:gecos:home:shell
      return parts.length >= 7 ? parts[6].trim() : null;
    }
  } catch (_) {}
  return null;
}

function probeOneShell(shellPath, mark) {
  const { spawnSync } = require('child_process');
  const t0 = Date.now();
  // -i sources interactive rc (~/.bashrc, ~/.zshrc), -l sources login
  // rc (~/.bash_profile, ~/.zprofile) — covers both styles.
  const r = spawnSync(
    shellPath,
    ['-ilc', `printf '%s:%s\\n' '${mark}' "$KUBECONFIG"`],
    { encoding: 'utf8', timeout: 2500 }
  );
  const out = { shell: shellPath, ms: Date.now() - t0, stdout: (r.stdout || '').slice(0, 400), stderr: (r.stderr || '').slice(0, 400), value: '', error: null };
  if (r.error) { out.error = String(r.error.message || r.error); return out; }
  const m = (r.stdout || '').match(new RegExp(`^${mark}:(.*)$`, 'm'));
  if (m) out.value = m[1];
  return out;
}

function probeKubeconfigFromShell() {
  if (process.env.KUBECONFIG) {
    kubeconfigProbe.source = 'env';
    kubeconfigProbe.reason = '$KUBECONFIG already set in process env (terminal launch, launchctl setenv, or Info.plist LSEnvironment)';
    return;
  }
  if (process.platform === 'win32') {
    kubeconfigProbe.source = 'skipped';
    kubeconfigProbe.reason = 'win32 GUI launches inherit user env natively; no probe needed';
    return;
  }
  if (!app.isPackaged) {
    kubeconfigProbe.source = 'skipped';
    kubeconfigProbe.reason = 'dev launch already inherits shell env';
    return;
  }

  // Find the user's *configured* login shell from the system identity
  // store — more authoritative than $SHELL, which can be stale or
  // overridden. Tried first; $SHELL and the static fallback list catch
  // edge cases where the configured login shell isn't the one sourcing
  // the user's KUBECONFIG rc.
  const loginShell = findLoginShell();
  kubeconfigProbe.loginShell = loginShell;
  const fs = require('fs');
  const seen = new Set();
  const candidates = [];
  for (const s of [loginShell, process.env.SHELL, '/bin/bash', '/bin/zsh', '/bin/sh']) {
    if (!s || seen.has(s) || !fs.existsSync(s)) continue;
    seen.add(s);
    candidates.push(s);
  }

  const MARK = '__CLOUDPG_KCFG__';
  const t0 = Date.now();
  for (const sh of candidates) {
    const r = probeOneShell(sh, MARK);
    kubeconfigProbe.attempts.push(r);
    if (r.value) {
      process.env.KUBECONFIG = r.value;
      kubeconfigProbe.shell = sh;
      kubeconfigProbe.source = 'shell';
      kubeconfigProbe.reason = `read from ${sh} interactive-login env`;
      kubeconfigProbe.durationMs = Date.now() - t0;
      return;
    }
  }
  kubeconfigProbe.durationMs = Date.now() - t0;
  kubeconfigProbe.source = candidates.length === 0 ? 'error' : 'default';
  kubeconfigProbe.reason = candidates.length === 0
    ? 'no shell available to probe'
    : `tried ${candidates.length} shell(s); $KUBECONFIG was empty or missing in each (see attempts below)`;
}
probeKubeconfigFromShell();

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 960, minHeight: 600,
    backgroundColor: '#f6f4ef',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  win.loadFile('CloudPG Console.html');

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Opt-in debug for packaged GUI launches where stdout/stderr go nowhere
  // the user can see. Set with `launchctl setenv CLOUDPG_DEBUG 1` on
  // macOS to make it persist across Finder launches.
  if (process.env.CLOUDPG_DEBUG) {
    win.webContents.on('did-finish-load', () => win.webContents.openDevTools({ mode: 'right' }));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Safety net: a buggy library can still emit an unhandled 'error' (notably
// the k8s port-forward WebSocket on RBAC denial). Catch it here so the
// Electron process doesn't pop the "Uncaught Exception" dialog and die.
process.on('uncaughtException',  (e) => console.warn('[uncaughtException]',  e?.message || e));
process.on('unhandledRejection', (e) => console.warn('[unhandledRejection]', e?.message || e));

// ─────────────────────────────────────────────────────────────────
// IPC handlers — kubernetes
// ─────────────────────────────────────────────────────────────────

// Load the default kubeconfig but tolerate duplicate cluster/user/context
// names across merged files (common when KUBECONFIG points at multiple files
// from the same provider). First occurrence wins.
function loadKubeconfigSafe() {
  const kc = new k8s.KubeConfig();
  try { kc.loadFromDefault(); return kc; }
  catch (e) { if (!/Duplicate/i.test(e.message)) throw e; }

  const paths = (process.env.KUBECONFIG && process.env.KUBECONFIG.length
                  ? process.env.KUBECONFIG
                  : path.join(os.homedir(), '.kube', 'config')
                ).split(path.delimiter).filter(Boolean);

  const seenClusters = new Map();
  const seenUsers    = new Map();
  const seenContexts = new Map();
  let currentContext = '';
  for (const p of paths) {
    try {
      const tmp = new k8s.KubeConfig();
      tmp.loadFromFile(p);
      for (const c   of tmp.getClusters())  if (!seenClusters.has(c.name))   seenClusters.set(c.name, c);
      for (const u   of tmp.getUsers())     if (!seenUsers.has(u.name))      seenUsers.set(u.name, u);
      for (const ctx of tmp.getContexts())  if (!seenContexts.has(ctx.name)) seenContexts.set(ctx.name, ctx);
      if (!currentContext) currentContext = tmp.getCurrentContext();
    } catch (_) { /* skip unreadable files */ }
  }
  const merged = new k8s.KubeConfig();
  merged.loadFromOptions({
    clusters: [...seenClusters.values()],
    users:    [...seenUsers.values()],
    contexts: [...seenContexts.values()],
    currentContext,
  });
  return merged;
}

function makeKc(contextName) {
  const kc = loadKubeconfigSafe();
  if (contextName) kc.setCurrentContext(contextName);
  return kc;
}

// Normalize errors from kube/exec-auth/network failures into a short human
// string. Avoids printing multi-line aws/gcloud auth dumps.
function friendlyErr(e) {
  const raw = String(e?.message || e || 'unknown error');
  const first = raw.split('\n').map(l => l.trim()).filter(Boolean)[0] || raw;
  if (e?.code === 'EHOSTUNREACH') return `host unreachable: ${e.address}:${e.port}`;
  if (e?.code === 'ENOTFOUND')    return `host not found: ${e.hostname || e.address}`;
  if (e?.code === 'ETIMEDOUT')    return `connection timed out: ${e.address || ''}`;
  if (e?.code === 'ECONNREFUSED') return `connection refused: ${e.address}:${e.port}`;
  if (/session has expired/i.test(first)) return 'credentials expired — reauthenticate';
  return first.replace(/^aws: \[ERROR\]:\s*/i, '').slice(0, 240);
}

// Wraps an async fn so it always resolves to { ok, data | error }.
// Prevents Electron's "Error occurred in handler" auto-logging and gives
// the renderer a uniform shape it can surface in the UI.
function envelope(fn) {
  return async (...args) => {
    try { return { ok: true,  data:  await fn(...args) }; }
    catch (e) { return { ok: false, error: friendlyErr(e) }; }
  };
}

ipcMain.handle('k8s:listContexts', envelope(async () => {
  const kc = loadKubeconfigSafe();
  return kc.getContexts().map(c => ({
    name:      c.name,
    cluster:   c.cluster,
    user:      c.user,
    namespace: c.namespace || 'default',
  }));
}));

// Inspect the environment we'd use to load kubeconfigs, plus what we
// found when we tried. Used by the EmptyState when no contexts come
// back, so the user can see *why* (file missing, $KUBECONFIG not set in
// GUI launch env, parse error, zero contexts in the file, etc.) instead
// of staring at a permanent "Loading…" spinner.
ipcMain.handle('k8s:diagnose', envelope(async () => {
  const fs = require('fs');
  const kubeconfigEnv = process.env.KUBECONFIG || null;
  const defaultPath   = path.join(os.homedir(), '.kube', 'config');
  const sources       = kubeconfigEnv ? kubeconfigEnv.split(path.delimiter) : [defaultPath];

  const files = sources.map(p => {
    const exists = fs.existsSync(p);
    let readable = false, sizeBytes = 0;
    if (exists) {
      try { fs.accessSync(p, fs.constants.R_OK); readable = true; } catch (_) {}
      try { sizeBytes = fs.statSync(p).size; } catch (_) {}
    }
    return { path: p, exists, readable, sizeBytes };
  });

  let contextCount = 0;
  let loadError    = null;
  try {
    const kc = loadKubeconfigSafe();
    contextCount = kc.getContexts().length;
  } catch (e) {
    loadError = friendlyErr(e);
  }

  return {
    platform:           process.platform,
    arch:               process.arch,
    home:               process.env.HOME || os.homedir(),
    isPackaged:         app.isPackaged,
    kubeconfigEnv,            // value of $KUBECONFIG seen by this process
    kubeconfigProbe:    { ...kubeconfigProbe },  // full probe state for UI
    defaultPath,              // where we'd look if $KUBECONFIG is unset
    files,                    // per-file existence/readability/size
    contextCount,             // contexts the kube client saw
    loadError,                // friendly error from loading, if any
    pathEnv:            process.env.PATH || '',
  };
}));

ipcMain.handle('k8s:listNamespaces', envelope(async (_evt, contextName) => {
  const kc  = makeKc(contextName);
  const api = kc.makeApiClient(k8s.CoreV1Api);
  const res = await api.listNamespace();
  return res.body.items.map(ns => ns.metadata.name);
}));

ipcMain.handle('k8s:listCNPGClusters', envelope(async (_evt, contextName, namespace) => {
  const kc  = makeKc(contextName);
  const api = kc.makeApiClient(k8s.CustomObjectsApi);
  const res = await api.listNamespacedCustomObject(
    'postgresql.cnpg.io', 'v1', namespace, 'clusters'
  );
  return res.body.items.map(c => {
    const initdb = c.spec?.bootstrap?.initdb;
    return {
      name:       c.metadata.name,
      phase:      c.status?.phase ?? 'Unknown',
      ready:      c.status?.readyInstances ?? 0,
      instances:  c.spec.instances,
      pgVersion:  ((c.status?.image || c.spec?.imageName || '').split(':').pop().match(/^(\d+[\d.]*)/)?.[1] ?? '?'),
      primary:    c.status?.currentPrimary,
      // Seed with the bootstrap database (if any). Database CRs are layered
      // on top later in backend.js, and a matching CR will override the
      // initdb owner with the post-bootstrap value.
      databases:  initdb?.database ? [{ name: initdb.database, owner: initdb.owner || null }] : [],
    };
  });
}));

ipcMain.handle('k8s:listCNPGDatabases', envelope(async (_evt, contextName, namespace) => {
  const kc  = makeKc(contextName);
  const api = kc.makeApiClient(k8s.CustomObjectsApi);
  const res = await api.listNamespacedCustomObject(
    'postgresql.cnpg.io', 'v1', namespace, 'databases'
  );
  return res.body.items
    .map(d => ({
      name:    d.spec?.name,
      owner:   d.spec?.owner || null,
      cluster: d.spec?.cluster?.name,
      applied: !!d.status?.applied,
    }))
    .filter(d => d.name && d.cluster && d.applied);
}));

ipcMain.handle('k8s:listCNPGUsers', envelope(async (_evt, contextName, namespace, clusterName) => {
  const kc  = makeKc(contextName);
  const api = kc.makeApiClient(k8s.CoreV1Api);
  const res = await api.listNamespacedSecret(namespace);
  const prefix = `cnpg-${clusterName}-user-`;
  return res.body.items
    .filter(s => s.metadata.name.startsWith(prefix))
    .map(s => ({
      name:   s.metadata.name.slice(prefix.length),
      secret: s.metadata.name,
    }));
}));

ipcMain.handle('k8s:readUserSecret', envelope(async (_evt, contextName, namespace, secretName) => {
  const kc  = makeKc(contextName);
  const api = kc.makeApiClient(k8s.CoreV1Api);
  const res = await api.readNamespacedSecret(secretName, namespace);
  const d = res.body.data || {};
  const dec = s => s ? Buffer.from(s, 'base64').toString('utf8') : '';
  return {
    username: dec(d.username),
    password: dec(d.password),
    dbname:   dec(d.dbname),
    host:     dec(d.host),
    port:     dec(d.port) || '5432',
  };
}));

// ─────────────────────────────────────────────────────────────────
// IPC handlers — postgres
// ─────────────────────────────────────────────────────────────────

const sessions = new Map();

// Ask the API server whether the current context is allowed to create a
// pods/portforward in the namespace. Detects RBAC denial *before* we open
// a WebSocket the server will 403, avoiding the unhandled-error crash.
async function canPortForward(kc, namespace) {
  try {
    const api = kc.makeApiClient(k8s.AuthorizationV1Api);
    const res = await api.createSelfSubjectAccessReview({
      spec: { resourceAttributes: { namespace, verb: 'create', resource: 'pods', subresource: 'portforward' } },
    });
    return { allowed: !!res.body.status?.allowed, reason: res.body.status?.reason || '' };
  } catch (e) {
    // SSAR itself failed — proceed and let the actual operation report.
    return { allowed: true, reason: '(ssar unavailable)' };
  }
}

// Opens a local TCP server that port-forwards each connection to the
// cluster's current primary pod on port 5432. Attaches defensive error
// listeners so a transient WS failure can't take the main process down.
async function openPortForward(kc, namespace, clusterName) {
  const pf         = new k8s.PortForward(kc);
  const customApi  = kc.makeApiClient(k8s.CustomObjectsApi);

  const clusterRes = await customApi.getNamespacedCustomObject(
    'postgresql.cnpg.io', 'v1', namespace, 'clusters', clusterName
  );
  const podName = clusterRes.body.status?.currentPrimary;
  if (!podName) throw new Error(`No primary pod for cluster ${clusterName}`);

  const server = net.createServer((socket) => {
    // Prevent unhandled 'error' from killing the process if pg.Client
    // disconnects rudely or the WS folds underneath us.
    socket.on('error', (e) => { console.warn('[pf socket]', friendlyErr(e)); });
    pf.portForward(namespace, podName, [5432], socket, null, socket)
      .then((ws) => {
        if (ws && typeof ws.on === 'function') {
          ws.on('error', (e) => {
            console.warn('[pf ws]', friendlyErr(e));
            try { socket.destroy(); } catch (_) {}
          });
        }
      })
      .catch((err) => {
        console.warn('[pf]', friendlyErr(err));
        try { socket.destroy(); } catch (_) {}
      });
  });
  server.on('error', (e) => console.warn('[pf server]', friendlyErr(e)));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return { server, localPort: server.address().port };
}

ipcMain.handle('pg:connect', async (_evt, sessionId, opts) => {
  const { contextName, namespace, clusterName, user, password, database } = opts;
  let server;
  try {
    const kc = makeKc(contextName);

    const pfCheck = await canPortForward(kc, namespace);
    if (!pfCheck.allowed) {
      return { ok: false, error: `context "${contextName}" cannot port-forward in namespace "${namespace}"${pfCheck.reason ? ` (${pfCheck.reason})` : ''}` };
    }

    ({ server } = await openPortForward(kc, namespace, clusterName));
    const localPort = server.address().port;
    const client = new Client({
      host: '127.0.0.1', port: localPort,
      user, password, database,
      ssl: false,
      connectionTimeoutMillis: 10000,
    });
    await client.connect();
    sessions.set(sessionId, { client, server, localPort });
    const vr = await client.query('SELECT version()');
    return { ok: true, info: { server: vr.rows[0].version } };
  } catch (e) {
    try { server?.close(); } catch (_) {}
    return { ok: false, error: friendlyErr(e) };
  }
});

// Serialize all queries on a session through a promise chain. pg.Client
// rejects concurrent client.query() calls (deprecated in pg@8, removed in 9)
// and a single client also keeps BEGIN/COMMIT on the same connection so the
// REPL's transaction semantics work.
function chain(s, fn) {
  const prev = s.queue || Promise.resolve();
  const next = prev.then(fn, fn);
  s.queue = next.catch(() => {});
  return next;
}

ipcMain.handle('pg:query', async (_evt, sessionId, sql) => {
  const s = sessions.get(sessionId);
  if (!s) return { error: 'no session' };
  return chain(s, async () => {
    try {
      const res = await s.client.query(sql);
      return {
        command:  res.command,
        rowCount: res.rowCount,
        fields:   res.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
        rows:     res.rows,
      };
    } catch (e) {
      return { error: e.message, where: e.where, code: e.code };
    }
  });
});

ipcMain.handle('pg:disconnect', async (_evt, sessionId) => {
  const s = sessions.get(sessionId);
  if (!s) return;
  try { await s.client?.end(); } catch (_) {}
  try { s.server?.close(); } catch (_) {}
  sessions.delete(sessionId);
});

app.on('before-quit', async () => {
  for (const [id, s] of sessions) {
    try { await s.client?.end(); } catch (_) {}
    try { s.server?.close(); } catch (_) {}
  }
});
