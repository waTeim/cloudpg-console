// CloudPG Console — preload bridge
//
// Exposes a typed IPC surface to the renderer under `window.cloudpg`.
// Keep this file small: every method here corresponds 1:1 to an
// ipcMain.handle() in electron/main.js.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cloudpg', {
  k8s: {
    listContexts:     ()                       => ipcRenderer.invoke('k8s:listContexts'),
    diagnose:         ()                       => ipcRenderer.invoke('k8s:diagnose'),
    listNamespaces:   (ctx)                    => ipcRenderer.invoke('k8s:listNamespaces', ctx),
    listCNPGClusters:  (ctx, ns)               => ipcRenderer.invoke('k8s:listCNPGClusters', ctx, ns),
    listCNPGDatabases: (ctx, ns)               => ipcRenderer.invoke('k8s:listCNPGDatabases', ctx, ns),
    listCNPGUsers:     (ctx, ns, cluster)      => ipcRenderer.invoke('k8s:listCNPGUsers', ctx, ns, cluster),
    readUserSecret:   (ctx, ns, secretName)    => ipcRenderer.invoke('k8s:readUserSecret', ctx, ns, secretName),
  },
  pg: {
    connect:    (sessionId, opts) => ipcRenderer.invoke('pg:connect',    sessionId, opts),
    query:      (sessionId, sql)  => ipcRenderer.invoke('pg:query',      sessionId, sql),
    disconnect: (sessionId)       => ipcRenderer.invoke('pg:disconnect', sessionId),
  },
});
