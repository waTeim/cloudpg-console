/* ============================================================
   Sidebar — context → namespace → pg-cluster → [user] → database
   Anchored to root. PG-cluster expansion stops at the user
   selection until a user is picked, then exposes only the
   databases that user can access.
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

function PhaseBadge({ phase }) {
  const variant = window.PHASE_VARIANT[phase] || "warn";
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
  width, onResize, onCollapse,
  onOpenSession,
  highlightKey,
}) {
  const [query, setQuery] = useState("");
  const [openCtx, setOpenCtx] = useState(() => new Set(["prod-us-east-1", "team-alpha-eks"]));
  const [openNs, setOpenNs] = useState(() => new Set(["prod-us-east-1::platform", "team-alpha-eks::alpha-svc"]));
  const [openCl, setOpenCl] = useState(() => new Set());
  // Per-pg-cluster selected user: key = `${ctx}::${ns}::${cluster}`
  const [selectedUser, setSelectedUser] = useState(() => new Map());

  const toggleSet = (set, key, setter) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };

  const matches = (s) => !query || (s || "").toLowerCase().includes(query.toLowerCase());

  // Auto-expand matching parents when searching
  useEffect(() => {
    if (!query) return;
    const ns = new Set();
    const cls = new Set();
    const ctx = new Set();
    for (const [cn, c] of Object.entries(window.CONTEXTS)) {
      let ctxMatch = matches(cn);
      for (const n of c.namespaces) {
        let nsMatch = matches(n.name);
        for (const cluster of n.clusters) {
          const usersMatch = cluster.users.some(u => matches(u.name) || matches(u.secret));
          const dbsMatch = cluster.databases.some(d => matches(d));
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

  // ----- resize -----
  const gripRef = useRef(null);
  const onGripDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
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
    let clusters = 0, ns = 0, ctx = 0;
    for (const c of Object.values(window.CONTEXTS)) {
      ctx++;
      for (const n of c.namespaces) {
        ns++;
        clusters += n.clusters.length;
      }
    }
    return { clusters, ns, ctx };
  }, []);

  const contexts = Object.entries(window.CONTEXTS);

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <Icon name="cluster" size={14} />
        <span className="title">Clusters</span>
        <span className="pill">{totals.ctx} ctx · {totals.clusters} pg</span>
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

      <div className="tree">
        {contexts.map(([cn, c]) => {
          if (query) {
            const anyMatch = matches(cn) || c.namespaces.some(n => matches(n.name) ||
              n.clusters.some(cl => matches(cl.name) ||
                cl.databases.some(d => matches(d)) ||
                cl.users.some(u => matches(u.name) || matches(u.secret))));
            if (!anyMatch) return null;
          }
          const ctxOpen = openCtx.has(cn);
          const nsList = c.namespaces.filter(n => {
            if (!query) return true;
            if (matches(cn) || matches(n.name)) return true;
            return n.clusters.some(cl => matches(cl.name) ||
              cl.databases.some(d => matches(d)) ||
              cl.users.some(u => matches(u.name) || matches(u.secret)));
          });
          return (
            <React.Fragment key={cn}>
              <TreeRow
                depth={0}
                open={ctxOpen}
                hasChildren
                glyph={<Icon name="cluster" size={13} />}
                label={highlight(cn, query)}
                meta={c.region}
                onToggle={() => toggleSet(openCtx, cn, setOpenCtx)}
                onClick={() => toggleSet(openCtx, cn, setOpenCtx)}
              />
              {ctxOpen && nsList.map(n => {
                const nsKey = `${cn}::${n.name}`;
                const nsOpen = openNs.has(nsKey);
                const clusters = n.clusters.filter(cl => {
                  if (!query) return true;
                  if (matches(cn) || matches(n.name) || matches(cl.name)) return true;
                  return cl.databases.some(d => matches(d)) ||
                    cl.users.some(u => matches(u.name) || matches(u.secret));
                });
                return (
                  <React.Fragment key={nsKey}>
                    <TreeRow
                      depth={1}
                      open={nsOpen}
                      hasChildren={n.clusters.length > 0}
                      glyph={<Icon name="ns" size={13} />}
                      label={highlight(n.name, query)}
                      meta={n.clusters.length ? `${n.clusters.length}` : "—"}
                      onToggle={() => toggleSet(openNs, nsKey, setOpenNs)}
                      onClick={() => toggleSet(openNs, nsKey, setOpenNs)}
                    />
                    {nsOpen && clusters.map(cl => {
                      const clKey = `${cn}::${n.name}::${cl.name}`;
                      const clOpen = openCl.has(clKey);
                      const userName = selectedUser.get(clKey);
                      const user = userName ? cl.users.find(u => u.name === userName) : null;
                      const availableDbs = user ? user.databases : [];
                      return (
                        <React.Fragment key={clKey}>
                          <TreeRow
                            depth={2}
                            open={clOpen}
                            hasChildren
                            glyph={<Icon name="db" size={13} />}
                            label={highlight(cl.name, query)}
                            meta={`${cl.ready}/${cl.instances}`}
                            indicator={<PhaseBadge phase={cl.phase} />}
                            onToggle={() => toggleSet(openCl, clKey, setOpenCl)}
                            onClick={() => toggleSet(openCl, clKey, setOpenCl)}
                          />
                          {clOpen && !user && (
                            <>
                              <div
                                className="tree-row"
                                style={{
                                  paddingLeft: 6 + 3 * 14, cursor: "default",
                                  color: "var(--fg-mute)", fontSize: 10.5,
                                  textTransform: "uppercase", letterSpacing: "0.06em",
                                  fontFamily: "JetBrains Mono, monospace",
                                  minHeight: 22,
                                }}
                              >
                                <span className="chev is-leaf"></span>
                                <span className="label">Connect as…</span>
                                <span className="meta" style={{ color: "var(--fg-faint)" }}>{cl.users.length} users</span>
                              </div>
                              {cl.users.map(u => (
                                <div
                                  key={u.name}
                                  className="tree-row"
                                  style={{ paddingLeft: 6 + 3 * 14 }}
                                  onClick={() => {
                                    const next = new Map(selectedUser);
                                    next.set(clKey, u.name);
                                    setSelectedUser(next);
                                  }}
                                  title={`secret: ${u.secret}`}
                                >
                                  <span className="chev is-leaf"><Icon name="chev-right" size={12} /></span>
                                  <span className="glyph"><Icon name="key" size={12} /></span>
                                  <span className="label">{highlight(u.name, query)}</span>
                                  <span className="meta" style={{ color: u.role === "superuser" ? "var(--accent)" : "var(--fg-mute)" }}>
                                    {u.role}
                                  </span>
                                </div>
                              ))}
                            </>
                          )}
                          {clOpen && user && (
                            <>
                              <div
                                className="tree-row"
                                style={{
                                  paddingLeft: 6 + 3 * 14,
                                  fontFamily: "JetBrains Mono, monospace",
                                  fontSize: 11, minHeight: 22,
                                  color: "var(--fg-dim)",
                                  cursor: "default",
                                }}
                              >
                                <span className="chev is-leaf"></span>
                                <span className="glyph"><Icon name="user" size={12} /></span>
                                <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ color: "var(--fg-mute)" }}>as</span>
                                  <span style={{ color: "var(--fg)" }}>{user.name}</span>
                                  <span style={{ color: user.role === "superuser" ? "var(--accent)" : "var(--fg-mute)", fontSize: 10 }}>
                                    {user.role}
                                  </span>
                                </span>
                                <button
                                  onClick={() => {
                                    const next = new Map(selectedUser);
                                    next.delete(clKey);
                                    setSelectedUser(next);
                                  }}
                                  style={{
                                    color: "var(--fg-mute)", fontSize: 10,
                                    fontFamily: "inherit",
                                    background: "var(--bg-input)", border: "1px solid var(--line)",
                                    padding: "1px 6px", borderRadius: 3,
                                  }}
                                  title="Change user"
                                >change</button>
                              </div>
                              {availableDbs.length === 0 && (
                                <div className="tree-row" style={{ paddingLeft: 6 + 4 * 14, color: "var(--fg-faint)", fontStyle: "italic", cursor: "default" }}>
                                  <span className="chev is-leaf"></span>
                                  <span className="label">no databases granted</span>
                                </div>
                              )}
                              {availableDbs.map(dbName => {
                                const isHighlight = highlightKey ===
                                  `${cn}::${n.name}::${cl.name}::${user.name}::${dbName}`;
                                return (
                                  <div
                                    key={dbName}
                                    className={`tree-row${isHighlight ? " is-selected" : ""}`}
                                    style={{ paddingLeft: 6 + 4 * 14 }}
                                    onClick={() => onOpenSession({
                                      context: cn, namespace: n.name,
                                      cluster: cl.name, user: user.name, role: user.role,
                                      db: dbName,
                                    })}
                                    title={`Open psql session as ${user.name} on ${dbName}`}
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
                            </>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {nsOpen && n.clusters.length === 0 && (
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
        <span>watching {totals.ctx} contexts</span>
        <button className="refresh" onClick={() => {}}>
          <Icon name="refresh" size={12} /> refresh
        </button>
      </div>

      <div ref={gripRef} className="sidebar-grip" onMouseDown={onGripDown} />
    </aside>
  );
}

window.Sidebar = Sidebar;
