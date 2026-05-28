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

// Kick off a real postgres connect in the background after the tab is created.
// Walks through every context that can reach this target (from the union
// bootstrap) and uses the first one that successfully connects. This means a
// context lacking pods/portforward RBAC silently falls back to a peer that
// has it, instead of failing the whole target.
async function doConnect(id, target, updateTabFn) {
  const contexts = (target.contextOptions && target.contextOptions.length)
    ? target.contextOptions
    : [target.context].filter(Boolean);

  const attempts = [];
  for (const ctx of contexts) {
    try {
      const secretName = target.secret || `cnpg-${target.cluster}-user-${target.user}`;
      const credsRes = await window.cloudpg.k8s.readUserSecret(ctx, target.namespace, secretName);
      if (!credsRes || !credsRes.ok) {
        attempts.push(`${ctx}: read secret — ${credsRes?.error || 'unknown'}`);
        continue;
      }
      const creds = credsRes.data;

      const result = await window.cloudpg.pg.connect(id, {
        contextName: ctx,
        namespace:   target.namespace,
        clusterName: target.cluster,
        user:        creds.username || target.user,
        password:    creds.password,
        database:    target.db,
      });
      if (!result.ok) {
        attempts.push(`${ctx}: ${result.error}`);
        continue;
      }

      const dbsRes = await window.cloudpg.pg.query(id,
        "SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname");
      const allDatabases = dbsRes.rows ? dbsRes.rows.map(r => r.datname) : [target.db];
      const pgVersion = (result.info?.server || '').match(/PostgreSQL\s+([\d.]+)/)?.[1]
        || target.pgVersion || '?';

      updateTabFn(id, {
        connected:    true,
        context:      ctx,
        pgVersion,
        allDatabases,
        log: [
          { kind: 'welcome', text: result.info?.server || 'Connected' },
          { kind: 'welcome', text: `Connected to database "${target.db}" as "${creds.username || target.user}" via ${ctx}.` },
          { kind: 'notice',  text: 'Type "\\?" for help.' },
        ],
      });
      window.backend.introspect(id, target.db);
      return;
    } catch (err) {
      attempts.push(`${ctx}: ${err.message || err}`);
    }
  }

  const summary = contexts.length > 1
    ? `Failed via all ${contexts.length} available contexts:\n  ${attempts.join('\n  ')}`
    : (attempts[0] || 'no contexts available');
  updateTabFn(id, { log: [{ kind: 'error', text: summary }] });
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
      <span className="bc-chip" title="CNPG cluster">
        <Icon name="db" size={11} />
        <span className="lab">pg</span>
        <span className="val">{tab.cluster}</span>
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
    setTabs(prev => prev.map(tab => tab.id === id ? { ...tab, ...patch } : tab));
  }, [closeTab]);

  updateTabRef.current = updateTabWithClose;

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
        pgVersion:      target.pgVersion || '?',
        ready:          target.ready  ?? 0,
        instances:      target.instances ?? 0,
        allUsers:       target.users || [],
        allDatabases:   [target.db],
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
