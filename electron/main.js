// CloudPG Console — Electron main process
//
// Responsibilities:
//   1. Create the BrowserWindow that loads `CloudPG Console.html`.
//   2. Expose IPC handlers for kubernetes + postgres operations so
//      the renderer can stay sandboxed (contextIsolation: true).
//
// The IPC handler bodies are written as stubs returning `null` /
// `[]` until you `npm install` and uncomment the integration code.
// The shapes returned by each handler match what the renderer
// currently constructs from `src/data.js`, so swapping is a 1:1
// replacement once the handlers are wired.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const net  = require('net');

// === Integration imports — uncomment after `npm install` =========
// const k8s = require('@kubernetes/client-node');
// const { Client } = require('pg');

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

  // External links open in the user's browser, not a new BrowserWindow.
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

// ─────────────────────────────────────────────────────────────────
// IPC handlers — kubernetes
// ─────────────────────────────────────────────────────────────────
//
// The KubeConfig loader honors $KUBECONFIG natively, including the
// colon-separated multi-file form. No special handling needed.

function makeKc(contextName) {
  // const kc = new k8s.KubeConfig();
  // kc.loadFromDefault();
  // if (contextName) kc.setCurrentContext(contextName);
  // return kc;
  return null;
}

ipcMain.handle('k8s:listContexts', async () => {
  // const kc = new k8s.KubeConfig();
  // kc.loadFromDefault();
  // return kc.getContexts().map(c => ({
  //   name:      c.name,
  //   cluster:   c.cluster,
  //   user:      c.user,
  //   namespace: c.namespace || 'default',
  // }));
  return [];
});

ipcMain.handle('k8s:listNamespaces', async (_evt, contextName) => {
  // const kc  = makeKc(contextName);
  // const api = kc.makeApiClient(k8s.CoreV1Api);
  // const res = await api.listNamespace();
  // return res.body.items.map(ns => ns.metadata.name);
  return [];
});

// Lists postgresql.cnpg.io/v1 Cluster CRs in a namespace.
ipcMain.handle('k8s:listCNPGClusters', async (_evt, contextName, namespace) => {
  // const kc  = makeKc(contextName);
  // const api = kc.makeApiClient(k8s.CustomObjectsApi);
  // const res = await api.listNamespacedCustomObject(
  //   'postgresql.cnpg.io', 'v1', namespace, 'clusters'
  // );
  // return res.body.items.map(c => ({
  //   name:       c.metadata.name,
  //   phase:      c.status?.phase ?? 'Unknown',
  //   ready:      c.status?.readyInstances ?? 0,
  //   instances:  c.spec.instances,
  //   pgVersion:  c.status?.pgVersion ?? c.spec.imageName,
  //   primary:    c.status?.currentPrimary,
  //   // The "main" database is the one initdb bootstraps. Other DBs
  //   // can exist; listing them requires SELECT datname FROM pg_database
  //   // post-connect — fill on demand from the renderer.
  //   databases:  [c.spec.bootstrap?.initdb?.database].filter(Boolean),
  // }));
  return [];
});

// Lists secrets matching `cnpg-<cluster>-user-*` in a namespace.
ipcMain.handle('k8s:listCNPGUsers', async (_evt, contextName, namespace, clusterName) => {
  // const kc  = makeKc(contextName);
  // const api = kc.makeApiClient(k8s.CoreV1Api);
  // const res = await api.listNamespacedSecret(namespace);
  // const prefix = `cnpg-${clusterName}-user-`;
  // return res.body.items
  //   .filter(s => s.metadata.name.startsWith(prefix))
  //   .map(s => ({
  //     name:   s.metadata.name.slice(prefix.length),
  //     secret: s.metadata.name,
  //   }));
  return [];
});

// Reads a user-credentials secret (data.username + data.password +
// optionally data.dbname / host / port). Decoded server-side so
// the password never lives in the renderer process.
ipcMain.handle('k8s:readUserSecret', async (_evt, contextName, namespace, secretName) => {
  // const kc  = makeKc(contextName);
  // const api = kc.makeApiClient(k8s.CoreV1Api);
  // const res = await api.readNamespacedSecret(secretName, namespace);
  // const d = res.body.data || {};
  // const dec = s => s ? Buffer.from(s, 'base64').toString('utf8') : '';
  // return {
  //   username: dec(d.username),
  //   password: dec(d.password),
  //   dbname:   dec(d.dbname),
  //   host:     dec(d.host),
  //   port:     dec(d.port) || '5432',
  // };
  return null;
});

// ─────────────────────────────────────────────────────────────────
// IPC handlers — postgres
// ─────────────────────────────────────────────────────────────────
// One pg.Client per renderer-side session (= tab). Each gets its
// own port-forward to <cluster>-rw.<ns>.svc:5432 over a local socket.

const sessions = new Map();   // sessionId -> { client, server, localPort }

async function openPortForward(kc, namespace, clusterName) {
  // const pf = new k8s.PortForward(kc);
  // const server = net.createServer(socket => {
  //   // The rw service routes to the current primary pod automatically;
  //   // resolve to a pod name via the endpoints API or just label-select.
  //   pf.portForward(namespace, /* primary pod name */, [5432], socket, null, socket);
  // });
  // await new Promise(r => server.listen(0, '127.0.0.1', r));
  // const localPort = server.address().port;
  // return { server, localPort };
  return { server: null, localPort: 0 };
}

ipcMain.handle('pg:connect', async (_evt, sessionId, opts) => {
  // const { contextName, namespace, clusterName, user, password, database } = opts;
  // const kc = makeKc(contextName);
  // const { server, localPort } = await openPortForward(kc, namespace, clusterName);
  // const client = new Client({
  //   host: '127.0.0.1', port: localPort,
  //   user, password, database,
  //   ssl: false,            // tighten for prod
  // });
  // await client.connect();
  // sessions.set(sessionId, { client, server, localPort });
  // return { ok: true, info: { server: await client.query('SELECT version()').then(r => r.rows[0].version) } };
  return { ok: false, error: 'not implemented — uncomment integration in electron/main.js' };
});

ipcMain.handle('pg:query', async (_evt, sessionId, sql) => {
  // const s = sessions.get(sessionId);
  // if (!s) return { error: 'no session' };
  // try {
  //   const res = await s.client.query(sql);
  //   return {
  //     command:  res.command,
  //     rowCount: res.rowCount,
  //     fields:   res.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
  //     rows:     res.rows,
  //   };
  // } catch (e) {
  //   return { error: e.message, where: e.where, code: e.code };
  // }
  return { error: 'not implemented' };
});

ipcMain.handle('pg:disconnect', async (_evt, sessionId) => {
  const s = sessions.get(sessionId);
  if (!s) return;
  try { await s.client?.end(); } catch (e) {}
  try { s.server?.close(); } catch (e) {}
  sessions.delete(sessionId);
});

app.on('before-quit', async () => {
  for (const [id] of sessions) {
    await ipcMain.invoke?.('pg:disconnect', id);
  }
});
