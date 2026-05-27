/* ============================================================
   Sidebar — context → namespace → pg-cluster → [user] → database
   ============================================================ */

const { useState, useMemo, useRef, useEffect } = React;

function highlight(label, query) {
  if (!query || typeof label !== "string") return label;
  const i = label.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return label;
  return (
    <>
      {label.slice(0, i)}
      <span style={{ color: "var(--accent)" }}>{label.slice(i, i + query.length)}</span>
      {label.slice(i + query.length)}
    </>
  );
}

// Compact 3-4 char labels for the sidebar where horizontal room is tight.
// Full phase text is preserved in the title attribute (tooltip on hover).
const PHASE_SHORT = {
  "Healthy":                  "OK",
  "Cluster in healthy state": "OK",
  "Upgrading":                "UPG",
  "Failing over":             "FAIL",
  "Degraded":                 "DEG",
  "Unknown":                  "?",
};

function PhaseBadge({ phase, compact = false }) {
  const variant = window.PHASE_VARIANT[phase] || "warn";
  if (compact) {
    const short = PHASE_SHORT[phase] || phase.slice(0, 4).toUpperCase();
    return (
      <span className={`badge ${variant}`} title={phase}>
        <span className="dot" />
        {short}
      </span>
    );
  }
  return (
    <span className={`badge ${variant}`}>
      <span className="dot" />
      {phase}
    </span>
  );
}

function TreeRow({
  depth = 0, open, hasChildren, glyph, label, meta, selected,
  onClick, onToggle, indicator, secondary,
}) {
  return (
    <div
      className={`tree-row${selected ? " is-selected" : ""}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={onClick}
    >
      <span
        className={`chev${hasChildren ? "" : " is-leaf"}${open ? " is-open" : ""}`}
        onClick={(e) => { e.stopPropagation(); onToggle && onToggle(); }}
      >
        <Icon name="chev-right" size={12} />
      </span>
      {glyph && <span className="glyph">{glyph}</span>}
      <span className="label">{label}</span>
      {secondary && <span className="meta">{secondary}</span>}
      {indicator}
      {meta && <span className="meta">{meta}</span>}
    </div>
  );
}

function Sidebar({
  contexts,
  width, onResize, onCollapse,
  onOpenSession,
  highlightKey,
  onRefresh,
}) {
  const [query, setQuery] = useState("");
  const [openCtx,  setOpenCtx]  = useState(() => new Set());
  const [openNs,   setOpenNs]   = useState(() => new Set());
  const [openCl,   setOpenCl]   = useState(() => new Set());
  const [openUser, setOpenUser] = useState(() => new Set());
  const treeRef = useRef(null);

  const toggleSet = (set, key, setter) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };

  const matches = (s) => !query || (s || "").toLowerCase().includes(query.toLowerCase());

  useEffect(() => {
    if (!query) return;
    const ns = new Set(), cls = new Set(), ctx = new Set();
    for (const [cn, c] of Object.entries(contexts || {})) {
      const ctxMatch = matches(cn);
      for (const n of (c.namespaces || [])) {
        const nsMatch = matches(n.name);
        for (const cluster of (n.clusters || [])) {
          const usersMatch = (cluster.users || []).some(u => matches(u.name));
          const dbsMatch   = (cluster.databases || []).some(d => matches(d));
          if (matches(cluster.name) || usersMatch || dbsMatch) {
            cls.add(`${cn}::${n.name}::${cluster.name}`);
            ns.add(`${cn}::${n.name}`);
            ctx.add(cn);
          }
          if (nsMatch || ctxMatch) { ns.add(`${cn}::${n.name}`); ctx.add(cn); }
        }
        if (nsMatch || ctxMatch) { ctx.add(cn); }
      }
    }
    setOpenCtx(s => new Set([...s, ...ctx]));
    setOpenNs(s => new Set([...s, ...ns]));
    setOpenCl(s => new Set([...s, ...cls]));
  }, [query]);

  // Tab → sidebar sync: when a tab becomes active, expand every ancestor of
  // its target row and scroll the row into view so the user can see where
  // they are in the tree.
  useEffect(() => {
    if (!highlightKey) return;
    const parts = highlightKey.split("::");
    if (parts.length !== 5) return;
    const [kc, ns, cl, u] = parts;
    setOpenCtx (s => s.has(kc)                         ? s : new Set([...s, kc]));
    setOpenNs  (s => s.has(`${kc}::${ns}`)             ? s : new Set([...s, `${kc}::${ns}`]));
    setOpenCl  (s => s.has(`${kc}::${ns}::${cl}`)      ? s : new Set([...s, `${kc}::${ns}::${cl}`]));
    setOpenUser(s => s.has(`${kc}::${ns}::${cl}::${u}`) ? s : new Set([...s, `${kc}::${ns}::${cl}::${u}`]));
  }, [highlightKey]);

  useEffect(() => {
    if (!highlightKey) return;
    // Wait a tick so the newly expanded rows are in the DOM.
    const t = setTimeout(() => {
      treeRef.current?.querySelector(".tree-row.is-selected")
        ?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => clearTimeout(t);
  }, [highlightKey]);

  // ----- resize -----
  const gripRef = useRef(null);
  const onGripDown = (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    gripRef.current?.classList.add("is-dragging");
    const move = (ev) => onResize(Math.max(220, Math.min(520, startW + (ev.clientX - startX))));
    const up = () => {
      gripRef.current?.classList.remove("is-dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const totals = useMemo(() => {
    let clusters = 0, ns = 0, kc = 0, ctx = 0;
    for (const c of Object.values(contexts || {})) {
      kc++;
      ctx += (c.contextNames || []).length;
      for (const n of (c.namespaces || [])) {
        ns++;
        clusters += (n.clusters || []).length;
      }
    }
    return { clusters, ns, kc, ctx };
  }, [contexts]);

  const ctxEntries = Object.entries(contexts || {});

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <Icon name="cluster" size={14} />
        <span className="title">Clusters</span>
        <span className="pill">{totals.kc} k8s · {totals.clusters} pg</span>
        <button
          title="Hide sidebar (⌘B)"
          onClick={onCollapse}
          style={{ width: 22, height: 22, display: "grid", placeItems: "center", color: "var(--fg-mute)", borderRadius: 4 }}
        >
          <Icon name="sidebar" size={14} />
        </button>
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={12} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter contexts, namespaces, dbs…"
        />
        {query && (
          <button onClick={() => setQuery("")} style={{ color: "var(--fg-mute)" }}>
            <Icon name="x" size={12} />
          </button>
        )}
        {!query && <span className="kbd">/</span>}
      </div>

      <div className="tree" ref={treeRef}>
        {ctxEntries.length === 0 && (
          <div className="tree-row" style={{ color: "var(--fg-mute)", fontStyle: "italic", cursor: "default", paddingLeft: 20 }}>
            <span className="label">Loading contexts…</span>
          </div>
        )}
        {ctxEntries.map(([cn, c]) => {
          if (query) {
            const anyMatch = matches(cn) || (c.namespaces || []).some(n =>
              matches(n.name) || (n.clusters || []).some(cl =>
                matches(cl.name) ||
                (cl.databases || []).some(d => matches(d)) ||
                (cl.users || []).some(u => matches(u.name))));
            if (!anyMatch) return null;
          }
          const ctxOpen = openCtx.has(cn);
          const nsList = (c.namespaces || []).filter(n => {
            if (!query) return true;
            if (matches(cn) || matches(n.name)) return true;
            return (n.clusters || []).some(cl =>
              matches(cl.name) ||
              (cl.databases || []).some(d => matches(d)) ||
              (cl.users || []).some(u => matches(u.name)));
          });
          return (
            <React.Fragment key={cn}>
              <TreeRow
                depth={0}
                open={ctxOpen}
                hasChildren
                glyph={<Icon name="cluster" size={13} />}
                label={highlight(cn, query)}
                meta={
                  (c.contextNames || []).length > 1
                    ? `${c.contextNames.length} ctx`
                    : (c.contextNames || [])[0]
                }
                indicator={
                  c.errors && Object.keys(c.errors).length > 0 && (() => {
                    const failed = Object.keys(c.errors).length;
                    const total  = (c.contextNames || []).length;
                    const allDown = failed === total;
                    return (
                      <span
                        className={`badge ${allDown ? "err" : "warn"}`}
                        title={Object.entries(c.errors).map(([k, v]) => `${k}: ${v}`).join('\n')}
                        style={{ cursor: 'help' }}
                      >
                        <span className="dot" />
                        {allDown ? "DOWN" : `${failed}!`}
                      </span>
                    );
                  })()
                }
                onToggle={() => toggleSet(openCtx, cn, setOpenCtx)}
                onClick={() => toggleSet(openCtx, cn, setOpenCtx)}
              />
              {ctxOpen && nsList.length === 0 && c.errors && Object.keys(c.errors).length > 0 && (
                Object.entries(c.errors).map(([ctxName, msg]) => (
                  <div
                    key={ctxName}
                    className="tree-row"
                    style={{
                      paddingLeft: 6 + 1 * 14,
                      color: "var(--fg-mute)", cursor: "default",
                      fontStyle: "italic", fontSize: 11,
                    }}
                    title={msg}
                  >
                    <span className="chev is-leaf"></span>
                    <span className="glyph"><Icon name="x" size={11} /></span>
                    <span className="label" style={{ color: "var(--err, var(--fg-mute))" }}>
                      {ctxName}: {msg}
                    </span>
                  </div>
                ))
              )}
              {ctxOpen && nsList.map(n => {
                const nsKey   = `${cn}::${n.name}`;
                const nsOpen  = openNs.has(nsKey);
                const clusters = (n.clusters || []).filter(cl => {
                  if (!query) return true;
                  if (matches(cn) || matches(n.name) || matches(cl.name)) return true;
                  return (cl.databases || []).some(d => matches(d)) ||
                         (cl.users || []).some(u => matches(u.name));
                });
                return (
                  <React.Fragment key={nsKey}>
                    <TreeRow
                      depth={1}
                      open={nsOpen}
                      hasChildren={(n.clusters || []).length > 0}
                      glyph={<Icon name="ns" size={13} />}
                      label={highlight(n.name, query)}
                      meta={(n.clusters || []).length ? `${n.clusters.length}` : "—"}
                      onToggle={() => toggleSet(openNs, nsKey, setOpenNs)}
                      onClick={() => toggleSet(openNs, nsKey, setOpenNs)}
                    />
                    {nsOpen && clusters.map(cl => {
                      const clKey  = `${cn}::${n.name}::${cl.name}`;
                      const clOpen = openCl.has(clKey);
                      return (
                        <React.Fragment key={clKey}>
                          <TreeRow
                            depth={2}
                            open={clOpen}
                            hasChildren
                            glyph={<Icon name="db" size={13} />}
                            label={highlight(cl.name, query)}
                            meta={`${cl.ready}/${cl.instances}`}
                            indicator={<PhaseBadge phase={cl.phase} compact />}
                            onToggle={() => toggleSet(openCl, clKey, setOpenCl)}
                            onClick={() => toggleSet(openCl, clKey, setOpenCl)}
                          />
                          {clOpen && (
                            <>
                              <div
                                className="tree-row"
                                style={{
                                  paddingLeft: 6 + 3 * 14, cursor: "default",
                                  color: "var(--fg-mute)", fontSize: 10.5,
                                  textTransform: "uppercase", letterSpacing: "0.06em",
                                  fontFamily: "JetBrains Mono, monospace", minHeight: 22,
                                }}
                              >
                                <span className="chev is-leaf"></span>
                                <span className="label">Connect as…</span>
                                <span className="meta" style={{ color: "var(--fg-faint)" }}>
                                  {(cl.users || []).length} {(cl.users || []).length === 1 ? "user" : "users"}
                                </span>
                              </div>
                              {(cl.users || []).map(u => {
                                const userKey  = `${clKey}::${u.name}`;
                                const userOpen = openUser.has(userKey);
                                const ctxs     = u.contextNames || cl.contextNames || n.contextNames || c.contextNames || [];
                                // Only this user's databases (from Database CR
                                // owner). Untagged entries are shown to all
                                // users as a fallback for legacy clusters.
                                const userDbs  = (cl.databases || [])
                                  .filter(d => !d.owner || d.owner === u.name)
                                  .map(d => d.name);
                                return (
                                  <React.Fragment key={u.name}>
                                    <TreeRow
                                      depth={3}
                                      open={userOpen}
                                      hasChildren={userDbs.length > 0}
                                      glyph={<Icon name="key" size={12} />}
                                      label={highlight(u.name, query)}
                                      meta={u.role || "user"}
                                      secondary={ctxs.length > 1 ? (
                                        <span style={{ color: "var(--accent)" }}>{ctxs.length} ctx</span>
                                      ) : null}
                                      onToggle={() => toggleSet(openUser, userKey, setOpenUser)}
                                      onClick={() => toggleSet(openUser, userKey, setOpenUser)}
                                    />
                                    {userOpen && userDbs.length === 0 && (
                                      <div className="tree-row" style={{ paddingLeft: 6 + 4 * 14, color: "var(--fg-faint)", fontStyle: "italic", cursor: "default" }}>
                                        <span className="chev is-leaf"></span>
                                        <span className="label">no databases available</span>
                                      </div>
                                    )}
                                    {userOpen && userDbs.map(dbName => {
                                      const isHighlight = highlightKey ===
                                        `${cn}::${n.name}::${cl.name}::${u.name}::${dbName}`;
                                      return (
                                        <div
                                          key={dbName}
                                          className={`tree-row${isHighlight ? " is-selected" : ""}`}
                                          style={{ paddingLeft: 6 + 4 * 14 }}
                                          onClick={() => onOpenSession({
                                            kubeCluster:    cn,
                                            context:        ctxs[0],
                                            contextOptions: ctxs,
                                            namespace:      n.name,
                                            cluster:        cl.name,
                                            user:           u.name,
                                            role:           u.role || '',
                                            secret:         u.secret || '',
                                            db:             dbName,
                                            phase:          cl.phase,
                                            pgVersion:      cl.pgVersion,
                                            ready:          cl.ready,
                                            instances:      cl.instances,
                                            users:          cl.users,
                                            databases:      cl.databases,
                                          })}
                                          title={`Open psql session as ${u.name} on ${dbName} (via ${ctxs[0] || 'default'})`}
                                        >
                                          <span className="chev is-leaf"><Icon name="chev-right" size={12} /></span>
                                          <span className="glyph"><Icon name="db" size={12} /></span>
                                          <span className="label">{highlight(dbName, query)}</span>
                                          <span className="meta" style={{ color: "var(--fg-faint)" }}>
                                            {dbName === "postgres" || dbName === "template1" ? "system" : "db"}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </React.Fragment>
                                );
                              })}
                            </>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {nsOpen && (n.clusters || []).length === 0 && (
                      <div className="tree-row" style={{ paddingLeft: 6 + 2 * 14, color: "var(--fg-faint)", cursor: "default", fontStyle: "italic" }}>
                        <span className="chev is-leaf"></span>
                        <span className="label">no CNPG clusters</span>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <span className="dot" style={{ width: 6, height: 6, borderRadius: 999, background: "var(--ok)", boxShadow: "0 0 0 2px oklch(0.78 0.18 152 / 0.18)" }} />
        <span>watching {totals.kc} clusters · {totals.ctx} contexts</span>
        <button className="refresh" onClick={onRefresh}>
          <Icon name="refresh" size={12} /> refresh
        </button>
      </div>

      <div ref={gripRef} className="sidebar-grip" onMouseDown={onGripDown} />
    </aside>
  );
}

window.Sidebar = Sidebar;
