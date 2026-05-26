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
const TWEAK_DEFAULTS = { theme: "paper", sidebarWidth: 280 };

// Kick off a real postgres connect in the background after the tab is created.
async function doConnect(id, target, updateTabFn) {
  try {
    const secretName = target.secret || `cnpg-${target.cluster}-user-${target.user}`;
    const creds = await window.cloudpg.k8s.readUserSecret(
      target.context, target.namespace, secretName
    );
    if (!creds) throw new Error('Could not read secret ' + secretName);

    const result = await window.cloudpg.pg.connect(id, {
      contextName: target.context,
      namespace:   target.namespace,
      clusterName: target.cluster,
      user:        creds.username || target.user,
      password:    creds.password,
      database:    target.db,
    });

    if (!result.ok) throw new Error(result.error);

    // List all accessible databases for \l and the sidebar's post-connect list.
    const dbsRes = await window.cloudpg.pg.query(id,
      "SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname");
    const allDatabases = dbsRes.rows ? dbsRes.rows.map(r => r.datname) : [target.db];

    // Extract pg version from banner, e.g. "PostgreSQL 16.2 on …"
    const pgVersion = (result.info?.server || '').match(/PostgreSQL\s+([\d.]+)/)?.[1]
      || target.pgVersion || '?';

    updateTabFn(id, {
      connected:    true,
      pgVersion,
      allDatabases,
      log: [
        { kind: 'welcome', text: result.info?.server || 'Connected' },
        { kind: 'welcome', text: `Connected to database "${target.db}" as "${creds.username || target.user}".` },
        { kind: 'notice',  text: 'Type "\\?" for help.' },
      ],
    });

    // Populate schema cache asynchronously (for \dt, autocomplete, etc.)
    window.backend.introspect(id, target.db);

  } catch (err) {
    updateTabFn(id, {
      log: [{ kind: 'error', text: String(err.message || err) }],
    });
  }
}

function Titlebar({ sidebarHidden, onToggleSidebar }) {
  return (
    <div className="titlebar">
      <button
        title={sidebarHidden ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
        onClick={onToggleSidebar}
        style={{ WebkitAppRegion: "no-drag", width: 28, height: 22, display: "grid", placeItems: "center", borderRadius: 4, color: "var(--fg-dim)" }}
      >
        <Icon name="sidebar" size={14} />
      </button>

      <div className="brand">
        <span className="logo"><Icon name="logo" size={11} /></span>
        <span className="name">CloudPG <span>Console</span></span>
      </div>

      <div className="center" />

      <div className="win-controls">
        <button title="Settings"><Icon name="settings" size={13} /></button>
        <button title="Minimize"><Icon name="min" size={13} /></button>
        <button title="Maximize"><Icon name="max" size={11} /></button>
        <button className="close" title="Close"><Icon name="x" size={13} /></button>
      </div>
    </div>
  );
}

function Tabbar({ tabs, activeId, onActivate, onClose, onNew }) {
  return (
    <div className="tabbar">
      <div className="tab-strip">
        {tabs.map(t => (
          <div
            key={t.id}
            className={`tab${t.id === activeId ? " is-active" : ""}`}
            onClick={() => onActivate(t.id)}
            title={`${t.user}@${t.cluster}/${t.db}  ·  ${t.context} · ns ${t.namespace}`}
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
  return (
    <div className="breadcrumb">
      <span className="bc-user" title={`secret: cnpg-${tab.cluster}-user-${tab.user}`}>
        <Icon name="user" size={11} />
        <span className="lab">as</span>
        <span className="val">{tab.user}</span>
        <span className="role">{tab.role}</span>
      </span>

      <span className="bc-divider" />

      <span className="bc-chip" title="Kubernetes context">
        <Icon name="cluster" size={11} />
        <span className="lab">ctx</span>
        <span className="val">{tab.context}</span>
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
          <span className="item">ctx <b>{tab.context}</b></span>
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

function EmptyState({ onOpenPalette, onPick, recents, contexts }) {
  const ctxCount  = Object.keys(contexts || {}).length;
  const allTargets = aUseMemo(() => window.flattenTargets(contexts), [contexts]);

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
          {ctxCount > 0
            ? <>Detected <b style={{color:"var(--fg)"}}>{ctxCount}</b> kubernetes contexts, <b style={{color:"var(--fg)"}}>{allTargets.length}</b> reachable (user, database) pairs.</>
            : <>Loading kubernetes contexts…</>
          }
          <br />
          Pick a target from the sidebar, or jump straight in with the switcher.
        </p>
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
                  <span className="ctx">{t.context}</span>
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

  const [sidebarWidth, setSidebarWidth] = aUseState(t.sidebarWidth ?? 280);
  const [sidebarHidden, setSidebarHidden] = aUseState(false);
  aUseEffect(() => { setSidebarWidth(t.sidebarWidth ?? 280); }, [t.sidebarWidth]);

  // k8s contexts, loaded async on startup
  const [contexts, setContexts] = aUseState({});

  const loadContexts = aUseCallback(async () => {
    try {
      const ctxData = await window.backend.bootstrap();
      setContexts(ctxData);
    } catch (err) {
      console.error('Failed to load contexts:', err);
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
    const key = `${target.context}::${target.namespace}::${target.cluster}::${target.user}::${target.db}`;

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
        context:      target.context,
        namespace:    target.namespace,
        cluster:      target.cluster,
        user:         target.user,
        role:         target.role || '',
        db:           target.db,
        phase:        target.phase || 'Unknown',
        pgVersion:    target.pgVersion || '?',
        ready:        target.ready  ?? 0,
        instances:    target.instances ?? 0,
        allUsers:     target.users || [],
        allDatabases: [target.db],
        log:          [{ kind: 'welcome', text: 'Connecting…' }],
        history:      [],
        timing:       false,
      }];
    });

    pushRecent({ ...target, key });
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
      <Titlebar
        sidebarHidden={sidebarHidden}
        onToggleSidebar={() => setSidebarHidden(h => !h)}
      />

      <div className="app-body" data-sidebar={sidebarHidden ? "hidden" : "open"} style={{ "--sidebar-w": `${sidebarWidth}px` }}>
        <Sidebar
          contexts={contexts}
          width={sidebarWidth}
          onResize={(w) => { setSidebarWidth(w); setTweak("sidebarWidth", w); }}
          onCollapse={() => setSidebarHidden(true)}
          onOpenSession={openSession}
          highlightKey={activeTab ? activeTab.key : null}
          onRefresh={loadContexts}
        />

        <div className="main">
          <Tabbar
            tabs={tabs}
            activeId={activeId}
            onActivate={setActiveId}
            onClose={closeTab}
            onNew={() => setPaletteOpen(true)}
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
        <TweakButton
          label={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
          onClick={() => setSidebarHidden(h => !h)}
        />
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
