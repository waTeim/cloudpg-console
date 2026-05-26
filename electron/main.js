// CloudPG Console — Electron main process

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
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

// ─────────────────────────────────────────────────────────────────
// IPC handlers — kubernetes
// ─────────────────────────────────────────────────────────────────

function makeKc(contextName) {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  if (contextName) kc.setCurrentContext(contextName);
  return kc;
}

ipcMain.handle('k8s:listContexts', async () => {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.getContexts().map(c => ({
    name:      c.name,
    cluster:   c.cluster,
    user:      c.user,
    namespace: c.namespace || 'default',
  }));
});

ipcMain.handle('k8s:listNamespaces', async (_evt, contextName) => {
  const kc  = makeKc(contextName);
  const api = kc.makeApiClient(k8s.CoreV1Api);
  const res = await api.listNamespace();
  return res.body.items.map(ns => ns.metadata.name);
});

ipcMain.handle('k8s:listCNPGClusters', async (_evt, contextName, namespace) => {
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
});

ipcMain.handle('k8s:listCNPGUsers', async (_evt, contextName, namespace, clusterName) => {
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
});

ipcMain.handle('k8s:readUserSecret', async (_evt, contextName, namespace, secretName) => {
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
});

// ─────────────────────────────────────────────────────────────────
// IPC handlers — postgres
// ─────────────────────────────────────────────────────────────────

const sessions = new Map();

// Opens a local TCP server that port-forwards each connection to the
// cluster's current primary pod on port 5432.
async function openPortForward(kc, namespace, clusterName) {
  const pf         = new k8s.PortForward(kc);
  const customApi  = kc.makeApiClient(k8s.CustomObjectsApi);

  const clusterRes = await customApi.getNamespacedCustomObject(
    'postgresql.cnpg.io', 'v1', namespace, 'clusters', clusterName
  );
  const podName = clusterRes.body.status?.currentPrimary;
  if (!podName) throw new Error(`No primary pod for cluster ${clusterName}`);

  const server = net.createServer((socket) => {
    pf.portForward(namespace, podName, [5432], socket, null, socket)
      .catch((err) => socket.destroy(err));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return { server, localPort: server.address().port };
}

ipcMain.handle('pg:connect', async (_evt, sessionId, opts) => {
  const { contextName, namespace, clusterName, user, password, database } = opts;
  try {
    const kc = makeKc(contextName);
    const { server, localPort } = await openPortForward(kc, namespace, clusterName);
    const client = new Client({
      host: '127.0.0.1', port: localPort,
      user, password, database,
      ssl: false,
    });
    await client.connect();
    sessions.set(sessionId, { client, server, localPort });
    const vr = await client.query('SELECT version()');
    return { ok: true, info: { server: vr.rows[0].version } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pg:query', async (_evt, sessionId, sql) => {
  const s = sessions.get(sessionId);
  if (!s) return { error: 'no session' };
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
