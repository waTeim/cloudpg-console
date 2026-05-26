// CloudPG Console — Electron main process

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os   = require('os');
const net  = require('net');

const k8s = require('@kubernetes/client-node');
const { Client } = require('pg');

let win;

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
  return res.body.items.map(c => ({
    name:       c.metadata.name,
    phase:      c.status?.phase ?? 'Unknown',
    ready:      c.status?.readyInstances ?? 0,
    instances:  c.spec.instances,
    pgVersion:  ((c.status?.image || c.spec?.imageName || '').split(':').pop().match(/^(\d+[\d.]*)/)?.[1] ?? '?'),
    primary:    c.status?.currentPrimary,
    databases:  [c.spec.bootstrap?.initdb?.database].filter(Boolean),
  }));
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
