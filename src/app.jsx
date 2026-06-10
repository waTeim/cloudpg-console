/* ============================================================
   Top-level App: titlebar, tabbar, sidebar host, session host
   ============================================================ */

const {
  useState: aUseState,
  useEffect: aUseEffect,
  useCallback: aUseCallback,
  useMemo: aUseMemo,
  useRef: aUseRef,
} = React;

const RECENT_KEY  = "cloudpg.recents";
const TWEAK_DEFAULTS = { theme: "paper", sidebarWidth: 280, hideEmptyNs: true };
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatDebugValue(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function pgUiDebug(event, detail = {}) {
  if (!window.cloudpg?.debug?.pg) return;
  const fields = Object.entries(detail)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatDebugValue(v)}`)
    .join(" ");
  console.warn(`[cloudpg:pg-ui] ${event}${fields ? ` ${fields}` : ""}`);
}
window.pgUiDebug = pgUiDebug;

// Kick off a real postgres connect in the background after the tab is created.
// Walks through every context that can reach this target (from the union
// bootstrap) and uses the first one that successfully connects. This means a
// context lacking pods/portforward RBAC silently falls back to a peer that
// has it, instead of failing the whole target.
async function doConnect(id, target, updateTabFn, opts = {}) {
  const isReconnect = !!opts.reconnect;
  const contexts = (target.contextOptions && target.contextOptions.length)
    ? target.contextOptions
    : [target.context].filter(Boolean);

  const attempts = [];
  pgUiDebug(isReconnect ? 'connect:reconnect-start' : 'connect:start', {
    id,
    key: target.key,
    contexts,
    namespace: target.namespace,
    cluster: target.cluster,
    user: target.user,
    db: target.db,
  });
  for (const ctx of contexts) {
    try {
      const secretName = target.secret || `cnpg-${target.cluster}-user-${target.user}`;
      pgUiDebug('connect:read-secret', { id, ctx, secretName });
      const credsRes = await window.cloudpg.k8s.readUserSecret(ctx, target.namespace, secretName);
      if (!credsRes || !credsRes.ok) {
        pgUiDebug('connect:read-secret-failed', { id, ctx, error: credsRes?.error || 'unknown' });
        attempts.push(`${ctx}: read secret — ${credsRes?.error || 'unknown'}`);
        continue;
      }
      const creds = credsRes.data;

      pgUiDebug('connect:ipc-connect', { id, ctx, database: target.db });
      const result = await window.cloudpg.pg.connect(id, {
        contextName: ctx,
        namespace:   target.namespace,
        clusterName: target.cluster,
        user:        creds.username || target.user,
        password:    creds.password,
        database:    target.db,
      });
      if (!result.ok) {
        pgUiDebug('connect:ipc-connect-failed', { id, ctx, error: result.error });
        attempts.push(`${ctx}: ${result.error}`);
        continue;
      }
      pgUiDebug('connect:ipc-connect-ok', { id, ctx, info: result.info });

      const dbsRes = await window.cloudpg.pg.query(id,
        "SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname");
      if (dbsRes.error) pgUiDebug('connect:list-databases-error', { id, ctx, error: dbsRes.error, disconnected: dbsRes.disconnected });
      const allDatabases = dbsRes.rows ? dbsRes.rows.map(r => r.datname) : [target.db];
      const pgVersion = (result.info?.server || '').match(/PostgreSQL\s+([\d.]+)/)?.[1]
        || target.pgVersion || '?';

      const tlsInfo = result.info?.tls;
      const welcomeLog = [
        { kind: 'welcome', text: result.info?.server || 'Connected' },
        { kind: 'welcome', text: `Connected to database "${target.db}" as "${creds.username || target.user}" via ${ctx}.` },
      ];
      if (tlsInfo) {
        welcomeLog.push({
          kind:  tlsInfo.startsWith('verified') ? 'ok' : 'notice',
          text:  `TLS: ${tlsInfo}`,
        });
      }
      welcomeLog.push({ kind: 'notice', text: 'Type "\\?" for help.' });

      const patch = {
        connected:    true,
        connectionState: 'connected',
        reconnect:    null,
        context:      ctx,
        pgVersion,
        allDatabases,
        tlsActive:    tlsInfo || null,   // 'verified (...)', 'disabled (...)', etc.
      };
      if (!isReconnect) patch.log = welcomeLog;
      updateTabFn(id, patch);
      if (!isReconnect) window.backend.introspect(id, target.db);
      pgUiDebug(isReconnect ? 'connect:reconnect-ok' : 'connect:ok', { id, ctx, key: target.key });
      return { ok: true };
    } catch (err) {
      pgUiDebug('connect:exception', { id, ctx, error: err.message || String(err) });
      attempts.push(`${ctx}: ${err.message || err}`);
    }
  }

  const summary = contexts.length > 1
    ? `Failed via all ${contexts.length} available contexts:\n  ${attempts.join('\n  ')}`
    : (attempts[0] || 'no contexts available');
  if (!isReconnect) {
    updateTabFn(id, {
      connected: false,
      connectionState: 'failed',
      log: [{ kind: 'error', text: summary }],
    });
  }
  pgUiDebug(isReconnect ? 'connect:reconnect-failed' : 'connect:failed', { id, summary });
  return { ok: false, error: summary };
}

function Titlebar() {
  return (
    <div className="titlebar">
      <div className="brand">
        <span className="logo"><Icon name="logo" size={11} /></span>
        <span className="name">CloudPG <span>Console</span></span>
      </div>

      <div className="center" />

      <div className="win-controls">
        <button
          title="Settings"
          onClick={() => window.postMessage({ type: "__toggle_edit_mode" }, "*")}
        >
          <Icon name="settings" size={13} />
        </button>
        <button className="os-provided" title="Minimize"><Icon name="min" size={13} /></button>
        <button className="os-provided" title="Maximize"><Icon name="max" size={11} /></button>
        <button className="os-provided close" title="Close"><Icon name="x" size={13} /></button>
      </div>
    </div>
  );
}

function Tabbar({ tabs, activeId, onActivate, onClose, onNew, sidebarHidden, onShowSidebar }) {
  return (
    <div className="tabbar">
      {sidebarHidden && (
        <button
          className="tab-expand-sidebar"
          onClick={onShowSidebar}
          title="Show sidebar (⌘B)"
        >
          <Icon name="sidebar" size={14} />
        </button>
      )}
      <div className="tab-strip">
        {tabs.map(t => (
          <div
            key={t.id}
            className={`tab${t.id === activeId ? " is-active" : ""}`}
            onClick={() => onActivate(t.id)}
            title={`${t.user}@${t.cluster}/${t.db}  ·  ${t.kubeCluster || t.context} · ns ${t.namespace}`}
          >
            <span className="tab-icon"><Icon name="db" size={12} /></span>
            <span className="tab-label">
              <span className="t-user">{t.user}</span>
              <span className="t-at">@</span>
              <span className="t-pg">{t.cluster}<span className="t-slash">/</span></span>
              <span className="t-db">{t.db}</span>
            </span>
            <span
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              title="Close tab"
            >
              <Icon name="x" size={11} />
            </span>
          </div>
        ))}
        <button className="tab-new" onClick={onNew} title="New tab (⌘K, ⌘T)">
          <Icon name="plus" size={14} />
        </button>
      </div>
    </div>
  );
}

function Breadcrumb({ tab }) {
  const phaseVariant = window.PHASE_VARIANT[tab.phase] || "warn";
  const ctxList = tab.contextOptions || (tab.context ? [tab.context] : []);
  return (
    <div className="breadcrumb">
      <span className="bc-user" title={`secret: ${tab.secret || `cnpg-${tab.cluster}-user-${tab.user}`}`}>
        <Icon name="user" size={11} />
        <span className="lab">as</span>
        <span className="val">{tab.user}</span>
        <span className="role">{tab.role}</span>
      </span>

      <span className="bc-divider" />

      <span className="bc-chip" title={`k8s cluster${ctxList.length ? `\nvia: ${ctxList.join(', ')}` : ''}`}>
        <Icon name="cluster" size={11} />
        <span className="lab">k8s</span>
        <span className="val">{tab.kubeCluster || tab.context}</span>
        {ctxList.length > 1 && (
          <span className="role" style={{ color: "var(--accent)" }}>{ctxList.length} ctx</span>
        )}
      </span>
      <span className="bc-sep">/</span>
      <span className="bc-chip" title="Namespace">
        <Icon name="ns" size={11} />
        <span className="lab">ns</span>
        <span className="val">{tab.namespace}</span>
      </span>
      <span className="bc-sep">/</span>
      <span
        className="bc-chip"
        title={
          tab.tlsActive
            ? `CNPG cluster · ${tab.tlsActive}`
            : tab.tls
              ? "CNPG cluster · TLS available"
              : "CNPG cluster"
        }
      >
        <Icon name="db" size={11} />
        <span className="lab">pg</span>
        <span className="val">{tab.cluster}</span>
        {(tab.tlsActive || tab.tls) && (
          <Icon
            name="lock"
            size={10}
            style={{
              marginLeft: 4,
              color: tab.tlsActive?.startsWith("verified") ? "var(--ok)" : "var(--fg-mute)",
            }}
          />
        )}
      </span>
      <span className="bc-sep">/</span>
      <span className="bc-chip" title="Database">
        <Icon name="db" size={11} />
        <span className="lab">db</span>
        <span className="val">{tab.db}</span>
      </span>

      <span className="bc-status">
        <span className={`badge ${phaseVariant}`}><span className="dot" />{tab.phase}</span>
        <span className="stat">ready <b>{tab.ready}/{tab.instances}</b></span>
        <span className="stat">pg <b>{tab.pgVersion}</b></span>
      </span>
    </div>
  );
}

function Statusbar({ tab, tabs }) {
  return (
    <div className="statusbar">
      <span className="item"><span className="dot" /> <b>Idle</b></span>
      {tab && (
        <>
          <span className="item">k8s <b>{tab.kubeCluster || tab.context}</b></span>
          <span className="item">ns <b>{tab.namespace}</b></span>
          <span className="item">db <b>{tab.db}</b></span>
          <span className="item">user <b>{tab.user}</b></span>
        </>
      )}
      <span className="right">
        <span className="item">tabs <b>{tabs.length}</b></span>
        <span className="item">UTF8 / en_US.utf8</span>
      </span>
    </div>
  );
}

function EmptyState({ onOpenPalette, onPick, recents, contexts, bootstrapState, bootstrapError }) {
  const ctxCount  = Object.keys(contexts || {}).length;
  const allTargets = aUseMemo(() => window.flattenTargets(contexts), [contexts]);
  const [diag, setDiag] = aUseState(null);

  // Only fetch + show diagnostics when bootstrap has actually FAILED:
  // it errored out, or it completed loading but found zero contexts.
  // While still loading, the spinner copy is enough — popping the diag
  // panel during a normal-but-slow init is just noise.
  const showDiag = bootstrapState === 'error'
    || (bootstrapState === 'loaded' && ctxCount === 0);

  aUseEffect(() => {
    if (!showDiag) { setDiag(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await window.cloudpg.k8s.diagnose();
        if (!cancelled) setDiag(r?.ok ? r.data : { loadError: r?.error || 'diagnose failed' });
      } catch (e) {
        if (!cancelled) setDiag({ loadError: String(e?.message || e) });
      }
    })();
    return () => { cancelled = true; };
  }, [showDiag]);

  const samples = aUseMemo(() => {
    return [...recents.slice(0, 2),
            ...allTargets.filter(t => !recents.some(r => r.key === t.key)).slice(0, 3)]
      .slice(0, 4);
  }, [recents, allTargets]);

  return (
    <div className="empty">
      <div className="card">
        <div className="glyph"><Icon name="logo" size={28} /></div>
        <h1>Open a Postgres cluster</h1>
        <p>
          {ctxCount > 0 ? (
            <>Detected <b style={{color:"var(--fg)"}}>{ctxCount}</b> kubernetes contexts, <b style={{color:"var(--fg)"}}>{allTargets.length}</b> reachable (user, database) pairs.</>
          ) : bootstrapState === 'loading' ? (
            <>Loading kubernetes contexts…</>
          ) : bootstrapState === 'error' ? (
            <>Failed to load kubernetes contexts.</>
          ) : (
            <>No kubernetes contexts found.</>
          )}
          <br />
          {ctxCount > 0
            ? <>Pick a target from the sidebar, or jump straight in with the switcher.</>
            : showDiag
              ? <>See diagnostics below.</>
              : <>This usually takes a moment.</>}
        </p>

        {diag && showDiag && (
          <div className="empty-diag">
            <div className="empty-diag-title">
              Diagnostics
              {bootstrapState === 'error' && bootstrapError && (
                <span style={{ marginLeft: 8, color: "var(--err)", fontWeight: 400 }}>
                  · {bootstrapError}
                </span>
              )}
            </div>
            <div className="empty-diag-row">
              <span>$KUBECONFIG</span>
              <code>{diag.kubeconfigEnv || <em>not set</em>}</code>
            </div>
            {diag.kubeconfigProbe && (
              <>
                <div className="empty-diag-row">
                  <span>Probe source</span>
                  <code>
                    {diag.kubeconfigProbe.source || "?"}
                    {diag.kubeconfigProbe.shell && (
                      <em style={{ marginLeft: 6, color: "var(--fg-mute)" }}>
                        via {diag.kubeconfigProbe.shell}
                      </em>
                    )}
                    {diag.kubeconfigProbe.durationMs != null && (
                      <em style={{ marginLeft: 6, color: "var(--fg-mute)" }}>
                        ({diag.kubeconfigProbe.durationMs}ms)
                      </em>
                    )}
                  </code>
                </div>
                {diag.kubeconfigProbe.loginShell && (
                  <div className="empty-diag-row">
                    <span>Login shell</span>
                    <code>{diag.kubeconfigProbe.loginShell} <em style={{color:"var(--fg-mute)"}}>(from dscl/getent)</em></code>
                  </div>
                )}
                {diag.kubeconfigProbe.reason && (
                  <div className="empty-diag-row">
                    <span>Probe reason</span>
                    <code>{diag.kubeconfigProbe.reason}</code>
                  </div>
                )}
                {(diag.kubeconfigProbe.attempts || []).map((a, i) => (
                  <div className="empty-diag-row" key={i}>
                    <span>Probe #{i + 1}</span>
                    <code style={{ whiteSpace: "pre-wrap" }}>
                      {a.shell} ({a.ms}ms){a.value ? ` → ${a.value}` : " → empty"}
                      {a.error   && `\n  error: ${a.error}`}
                      {a.stderr  && `\n  stderr: ${a.stderr.trim()}`}
                    </code>
                  </div>
                ))}
              </>
            )}
            <div className="empty-diag-row">
              <span>Default path</span>
              <code>{diag.defaultPath}</code>
            </div>
            {(diag.files || []).map(f => (
              <div className="empty-diag-row" key={f.path}>
                <span>{f.path.split('/').slice(-2).join('/')}</span>
                <code>
                  {f.exists ? `${f.sizeBytes} bytes` : "missing"}
                  {f.exists && !f.readable && " (unreadable)"}
                </code>
              </div>
            ))}
            <div className="empty-diag-row">
              <span>Contexts found</span>
              <code>{diag.contextCount ?? 0}</code>
            </div>
            {diag.loadError && (
              <div className="empty-diag-row err">
                <span>Load error</span>
                <code>{diag.loadError}</code>
              </div>
            )}
            {(!diag.kubeconfigEnv && (diag.contextCount === 0 || (diag.files || []).every(f => !f.exists))) && (
              <div className="empty-diag-hint">
                Tip: if you set <code>$KUBECONFIG</code> in your shell rc files, macOS Finder/dock launches
                don't see it. Either run <code>launchctl setenv KUBECONFIG "$KUBECONFIG"</code> in a
                terminal once, or symlink your config to <code>~/.kube/config</code>.
              </div>
            )}
          </div>
        )}

        <div className="kbd-row">
          <button className="cmdk-btn" style={{ minWidth: 320 }} onClick={onOpenPalette}>
            <Icon name="search" size={12} />
            <span>Switch context, namespace, database, user…</span>
            <span className="kbd"><kbd>⌘</kbd><kbd>K</kbd></span>
          </button>
        </div>

        {samples.length > 0 && (
          <div className="recents">
            <div className="head">{recents.length ? "Recent" : "Suggested"}</div>
            {samples.map(t => (
              <div key={t.key} className="row" onClick={() => onPick(t)}>
                <Icon name="db" size={13} />
                <span className="path">
                  <span className="ctx">{t.kubeCluster || t.context}</span>
                  <span className="sep">/</span>{t.namespace}
                  <span className="sep">/</span>{t.cluster}
                  <span className="sep">/</span>{t.user}
                </span>
                <span className="when">{t.role || "user"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  aUseEffect(() => {
    document.documentElement.setAttribute("data-theme", t.theme || "paper");
  }, [t.theme]);

  // Tag the document with the host platform so CSS can leave room for the
  // macOS traffic-light buttons in the titlebar. Also track window focus —
  // the lights vanish when the window is inactive, so the title should
  // slide back to the normal left padding to avoid looking off-center.
  aUseEffect(() => {
    const p = /Mac/i.test(navigator.platform) ? "darwin"
            : /Win/i.test(navigator.platform) ? "win32"
            : "linux";
    document.documentElement.setAttribute("data-platform", p);

    const setFocus = (v) => document.documentElement.setAttribute("data-focused", v ? "true" : "false");
    setFocus(document.hasFocus());
    const onFocus = () => setFocus(true);
    const onBlur  = () => setFocus(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur",  onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur",  onBlur);
    };
  }, []);

  const [sidebarWidth, setSidebarWidth] = aUseState(t.sidebarWidth ?? 280);
  const [sidebarHidden, setSidebarHidden] = aUseState(false);
  aUseEffect(() => { setSidebarWidth(t.sidebarWidth ?? 280); }, [t.sidebarWidth]);

  // k8s contexts, loaded async on startup. bootstrapState distinguishes
  // "still loading" (don't pop diagnostics) from "loaded but empty" /
  // "errored" (do show diagnostics — the user needs to see why).
  const [contexts, setContexts] = aUseState({});
  const [bootstrapState, setBootstrapState] = aUseState('loading');  // loading | loaded | error
  const [bootstrapError, setBootstrapError] = aUseState(null);

  const loadContexts = aUseCallback(async () => {
    setBootstrapState('loading');
    setBootstrapError(null);
    try {
      const ctxData = await window.backend.bootstrap();
      setContexts(ctxData);
      setBootstrapState('loaded');
    } catch (err) {
      console.error('Failed to load contexts:', err);
      setBootstrapError(String(err?.message || err));
      setBootstrapState('error');
    }
  }, []);

  aUseEffect(() => { loadContexts(); }, []);

  const [tabs, setTabs] = aUseState([]);
  const [activeId, setActiveId] = aUseState(null);
  const [paletteOpen, setPaletteOpen] = aUseState(false);
  const tabsRef = aUseRef([]);
  const reconnectingRef = aUseRef(new Map());
  aUseEffect(() => { tabsRef.current = tabs; }, [tabs]);

  const [recents, setRecentsRaw] = aUseState(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return [];
  });
  const pushRecent = aUseCallback((target) => {
    setRecentsRaw(prev => {
      const next = [target, ...prev.filter(p => p.key !== target.key)].slice(0, 6);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch (_) {}
      return next;
    });
  }, []);

  // Keep an always-current reference to updateTab for use in async callbacks.
  const updateTabRef = aUseRef(null);

  const closeTab = aUseCallback((id) => {
    reconnectingRef.current.delete(id);
    window.cloudpg?.pg?.disconnect(id).catch(() => {});
    setTabs(prev => {
      const idx  = prev.findIndex(tab => tab.id === id);
      const next = prev.filter(tab => tab.id !== id);
      if (id === activeId) {
        const newActive = next[idx] || next[idx - 1] || next[0];
        setActiveId(newActive ? newActive.id : null);
      }
      return next;
    });
  }, [activeId]);

  const updateTabWithClose = aUseCallback((id, patch) => {
    if (patch && patch._close) { closeTab(id); return; }
    setTabs(prev => prev.map(tab => {
      if (tab.id !== id) return tab;
      const nextPatch = typeof patch === "function" ? patch(tab) : patch;
      if (nextPatch && nextPatch._close) {
        setTimeout(() => closeTab(id), 0);
        return tab;
      }
      return { ...tab, ...(nextPatch || {}) };
    }));
  }, [closeTab]);

  updateTabRef.current = updateTabWithClose;

  const reconnectSession = aUseCallback(async (id, reason) => {
    const existing = reconnectingRef.current.get(id);
    if (existing) {
      pgUiDebug('reconnect:join-existing', { id, reason });
      return existing;
    }

    const promise = (async () => {
      pgUiDebug('reconnect:start', { id, reason });
      updateTabRef.current(id, (tab) => ({
        connected: false,
        connectionState: 'reconnecting',
        reconnect: { state: 'reconnecting', attempt: 1, max: RECONNECT_DELAYS.length, delayMs: 0, reason },
        log: [
          ...(tab.log || []),
          { kind: 'notice', text: `Connection lost${reason ? `: ${reason}` : ''}. Reconnecting…` },
        ],
      }));

      try {
        pgUiDebug('reconnect:disconnect-stale', { id });
        await window.cloudpg.pg.disconnect(id);
      } catch (e) {
        pgUiDebug('reconnect:disconnect-stale-error', { id, error: e.message || String(e) });
      }

      let lastError = reason || 'connection lost';
      for (let i = 0; i < RECONNECT_DELAYS.length; i++) {
        const attempt = i + 1;
        const delayMs = i === 0 ? 0 : RECONNECT_DELAYS[i - 1];
        if (delayMs > 0) {
          pgUiDebug('reconnect:wait', { id, attempt, delayMs, lastError });
          updateTabRef.current(id, {
            connectionState: 'waiting',
            reconnect: { state: 'waiting', attempt, max: RECONNECT_DELAYS.length, delayMs, reason: lastError },
          });
          await sleep(delayMs);
        }

        const tab = tabsRef.current.find(t => t.id === id);
        if (!tab) {
          pgUiDebug('reconnect:tab-missing', { id, attempt });
          return { ok: false, error: 'session closed' };
        }

        pgUiDebug('reconnect:attempt', { id, attempt, key: tab.key, context: tab.context, contextOptions: tab.contextOptions });
        updateTabRef.current(id, {
          connectionState: 'reconnecting',
          reconnect: { state: 'reconnecting', attempt, max: RECONNECT_DELAYS.length, delayMs: 0, reason: lastError },
        });

        const result = await doConnect(id, tab, (tabId, patch) => updateTabRef.current(tabId, patch), { reconnect: true });
        if (result.ok) {
          pgUiDebug('reconnect:ok', { id, attempt });
          updateTabRef.current(id, (current) => ({
            connected: true,
            connectionState: 'connected',
            reconnect: null,
            log: [...(current.log || []), { kind: 'ok', text: `Reconnected on attempt ${attempt}.` }],
          }));
          return { ok: true };
        }
        lastError = result.error || lastError;
        pgUiDebug('reconnect:attempt-failed', { id, attempt, error: lastError });
      }

      pgUiDebug('reconnect:failed', { id, error: lastError });
      updateTabRef.current(id, (tab) => ({
        connected: false,
        connectionState: 'failed',
        reconnect: { state: 'failed', attempt: RECONNECT_DELAYS.length, max: RECONNECT_DELAYS.length, delayMs: 0, reason: lastError },
      }));
      return { ok: false, error: lastError };
    })().finally(() => {
      pgUiDebug('reconnect:finished', { id });
      reconnectingRef.current.delete(id);
    });

    reconnectingRef.current.set(id, promise);
    return promise;
  }, []);

  aUseEffect(() => {
    const poll = async () => {
      for (const tab of tabsRef.current) {
        if (!tab.connected || tab.connectionState !== 'connected') continue;
        if (reconnectingRef.current.has(tab.id)) continue;
        try {
          const status = await window.cloudpg.pg.status(tab.id);
          if (status && status.connected === false) {
            pgUiDebug('status:disconnected', { id: tab.id, key: tab.key, error: status.error });
            reconnectSession(tab.id, status.error || 'connection lost');
          }
        } catch (e) {
          pgUiDebug('status:error', { id: tab.id, key: tab.key, error: e.message || String(e) });
          reconnectSession(tab.id, e.message || 'status check failed');
        }
      }
    };
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [reconnectSession]);

  const openSession = aUseCallback((target) => {
    const kubeCluster = target.kubeCluster || target.context;
    const key = `${kubeCluster}::${target.namespace}::${target.cluster}::${target.user}::${target.db}`;

    setTabs(prev => {
      const match = prev.find(p => p.key === key);
      if (match) {
        setActiveId(match.id);
        return prev;
      }
      const id = `tab-${Math.random().toString(36).slice(2, 8)}`;
      setActiveId(id);

      // Kick off the async connect — updateTabRef.current is always fresh.
      doConnect(id, { ...target, key }, (tabId, patch) => updateTabRef.current(tabId, patch));

      return [...prev, {
        id, key,
        kubeCluster,
        context:        target.context,
        contextOptions: target.contextOptions || (target.context ? [target.context] : []),
        namespace:      target.namespace,
        cluster:        target.cluster,
        user:           target.user,
        role:           target.role || '',
        secret:         target.secret || '',
        db:             target.db,
        phase:          target.phase || 'Unknown',
        tls:            !!target.tls,
        pgVersion:      target.pgVersion || '?',
        ready:          target.ready  ?? 0,
        instances:      target.instances ?? 0,
        allUsers:       target.users || [],
        allDatabases:   [target.db],
        connected:      false,
        connectionState: 'connecting',
        reconnect:      { state: 'connecting', attempt: 0, max: RECONNECT_DELAYS.length, delayMs: 0, reason: '' },
        log:            [{ kind: 'welcome', text: 'Connecting…' }],
        history:        [],
        timing:         false,
      }];
    });

    pushRecent({ ...target, kubeCluster, key });
  }, [pushRecent]);

  // ⌘K / ⌘B / ⌘W / ⌘T keyboard shortcuts
  aUseEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); setPaletteOpen(true);
      }
      if (e.key === "Escape" && paletteOpen) {
        setPaletteOpen(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarHidden(h => !h);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        if (activeId) { e.preventDefault(); closeTab(activeId); }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, activeId, closeTab]);

  const activeTab = tabs.find(t => t.id === activeId) || null;
  const sessionStatuses = aUseMemo(() => {
    const out = {};
    for (const tab of tabs) {
      if (!tab.key) continue;
      const reconnect = tab.reconnect;
      const state = reconnect?.state || tab.connectionState || (tab.connected ? 'connected' : 'connecting');
      if (state === 'connected' && !reconnect) continue;
      out[tab.key] = {
        state,
        attempt: reconnect?.attempt || 0,
        max: reconnect?.max || RECONNECT_DELAYS.length,
        delayMs: reconnect?.delayMs || 0,
        reason: reconnect?.reason || '',
      };
    }
    return out;
  }, [tabs]);

  return (
    <>
      <Titlebar />

      <div className="app-body" data-sidebar={sidebarHidden ? "hidden" : "open"} style={{ "--sidebar-w": `${sidebarWidth}px` }}>
        <Sidebar
          contexts={contexts}
          width={sidebarWidth}
          onResize={(w) => { setSidebarWidth(w); setTweak("sidebarWidth", w); }}
          onCollapse={() => setSidebarHidden(true)}
          onOpenSession={openSession}
          highlightKey={activeTab ? activeTab.key : null}
          sessionStatuses={sessionStatuses}
          onRefresh={loadContexts}
          hideEmptyNs={t.hideEmptyNs ?? true}
        />

        <div className="main">
          <Tabbar
            tabs={tabs}
            activeId={activeId}
            onActivate={setActiveId}
            onClose={closeTab}
            onNew={() => setPaletteOpen(true)}
            sidebarHidden={sidebarHidden}
            onShowSidebar={() => setSidebarHidden(false)}
          />

          {activeTab ? (
            <>
              <Breadcrumb tab={activeTab} />
              <Session
                tab={activeTab}
                onUpdateTab={(patch) => updateTabWithClose(activeTab.id, patch)}
                onReconnect={(reason) => reconnectSession(activeTab.id, reason)}
              />
            </>
          ) : (
            <EmptyState
              onOpenPalette={() => setPaletteOpen(true)}
              onPick={openSession}
              recents={recents}
              contexts={contexts}
              bootstrapState={bootstrapState}
              bootstrapError={bootstrapError}
            />
          )}
        </div>
      </div>

      <Statusbar tab={activeTab} tabs={tabs} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={(target) => { setPaletteOpen(false); openSession(target); }}
        recents={recents}
        contexts={contexts}
      />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme" />
        <TweakRadio
          label="Palette"
          value={t.theme}
          options={[
            { value: "ink",   label: "Ink" },
            { value: "paper", label: "Paper" },
            { value: "acid",  label: "Acid" },
          ]}
          onChange={(v) => setTweak("theme", v)}
        />
        <TweakSection label="Sidebar" />
        <TweakSlider
          label="Width"
          value={t.sidebarWidth}
          min={220} max={480} step={10} unit="px"
          onChange={(v) => { setTweak("sidebarWidth", v); setSidebarWidth(v); }}
        />
        <TweakToggle
          label="Hide empty namespaces"
          value={t.hideEmptyNs ?? true}
          onChange={(v) => setTweak("hideEmptyNs", v)}
        />
        <TweakButton
          label={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
          onClick={() => setSidebarHidden(h => !h)}
        />
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
