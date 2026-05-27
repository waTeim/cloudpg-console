/* ============================================================
   Sidebar — context → namespace → pg-cluster → [user] → database
   ============================================================ */

const { useState, useMemo, useRef, useEffect } = React;

function highlight(label, segments) {
  if (!segments || segments.length === 0 || typeof label !== "string") return label;
  // Highlight the first segment that occurs in this label. In a
  // multi-segment path query each level usually matches a different
  // segment, so per-row "first match" gives the right visual.
  for (const seg of segments) {
    const i = label.toLowerCase().indexOf(seg.toLowerCase());
    if (i >= 0) {
      return (
        <>
          {label.slice(0, i)}
          <span style={{ color: "var(--accent)" }}>{label.slice(i, i + seg.length)}</span>
          {label.slice(i + seg.length)}
        </>
      );
    }
  }
  return label;
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
  hideEmptyNs = true,
}) {
  const [query, setQuery] = useState("");
  const [openCtx,  setOpenCtx]  = useState(() => new Set());
  const [openNs,   setOpenNs]   = useState(() => new Set());
  const [openCl,   setOpenCl]   = useState(() => new Set());
  const [openUser, setOpenUser] = useState(() => new Set());
  const treeRef   = useRef(null);
  const searchRef = useRef(null);

  const toggleSet = (set, key, setter) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };

  // Path-aware filter. A query may contain "/" to anchor a chain of names
  // that must appear in consecutive levels (e.g. "icecream/claude" =
  // k8s-cluster icecream → namespace claude). A single segment matches
  // any level (substring). No anchor: the first segment can start at any
  // depth in the chain. `visible` is a Set of "kind:::path" keys; null
  // means "no filter, show everything".
  const segments = useMemo(
    () => (query || "").split("/").map(s => s.trim()).filter(Boolean),
    [query]
  );

  const visible = useMemo(() => {
    if (segments.length === 0) return null;
    const v = new Set();
    const inc = (s, sub) =>
      (typeof s === "string" ? s : String(s ?? "")).toLowerCase()
        .includes(sub.toLowerCase());
    // Does some contiguous slice of `chain` match every segment in order?
    const chainHit = (chain) => {
      if (chain.length < segments.length) return false;
      for (let start = 0; start <= chain.length - segments.length; start++) {
        let ok = true;
        for (let i = 0; i < segments.length; i++) {
          if (!inc(chain[start + i], segments[i])) { ok = false; break; }
        }
        if (ok) return true;
      }
      return false;
    };
    // When a chain matches, mark every prefix visible — descendants of a
    // matching level get visibility automatically because their longer
    // chains still contain the same slice.
    const markUpTo = (depth, a, b, c, u, d) => {
      if (depth >= 0) v.add(`k:${a}`);
      if (depth >= 1) v.add(`n:${a}::${b}`);
      if (depth >= 2) v.add(`c:${a}::${b}::${c}`);
      if (depth >= 3) v.add(`u:${a}::${b}::${c}::${u}`);
      if (depth >= 4) v.add(`d:${a}::${b}::${c}::${u}::${d}`);
    };

    for (const [cn, ctx] of Object.entries(contexts || {})) {
      if (chainHit([cn])) markUpTo(0, cn);
      for (const n of (ctx.namespaces || [])) {
        if (chainHit([cn, n.name])) markUpTo(1, cn, n.name);
        for (const cl of (n.clusters || [])) {
          if (chainHit([cn, n.name, cl.name])) markUpTo(2, cn, n.name, cl.name);
          for (const u of (cl.users || [])) {
            if (chainHit([cn, n.name, cl.name, u.name])) markUpTo(3, cn, n.name, cl.name, u.name);
            for (const db of (cl.databases || [])) {
              if (chainHit([cn, n.name, cl.name, u.name, db.name])) {
                markUpTo(4, cn, n.name, cl.name, u.name, db.name);
              }
            }
          }
        }
      }
    }
    return v;
  }, [contexts, segments]);

  // Helpers used by the render code to ask "should I show this row?"
  const showK = (cn)                  => !visible || visible.has(`k:${cn}`);
  const showN = (cn, n)               => !visible || visible.has(`n:${cn}::${n}`);
  const showC = (cn, n, cl)           => !visible || visible.has(`c:${cn}::${n}::${cl}`);
  const showU = (cn, n, cl, u)        => !visible || visible.has(`u:${cn}::${n}::${cl}::${u}`);
  const showD = (cn, n, cl, u, d)     => !visible || visible.has(`d:${cn}::${n}::${cl}::${u}::${d}`);

  // Auto-expand the tree to every level the filter made visible, so the
  // matches are immediately on screen.
  useEffect(() => {
    if (!visible) return;
    const k = new Set(), n = new Set(), c = new Set(), u = new Set();
    for (const key of visible) {
      if (key.startsWith("k:")) k.add(key.slice(2));
      else if (key.startsWith("n:")) n.add(key.slice(2));
      else if (key.startsWith("c:")) c.add(key.slice(2));
      else if (key.startsWith("u:")) u.add(key.slice(2));
    }
    setOpenCtx(s => new Set([...s, ...k]));
    setOpenNs (s => new Set([...s, ...n]));
    setOpenCl (s => new Set([...s, ...c]));
    setOpenUser(s => new Set([...s, ...u]));
  }, [visible]);

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

  // "/" focuses the filter, matching the kbd hint shown in the search row.
  // Ignored when the user is already typing in an input/textarea (so it
  // doesn't hijack a literal slash inside the REPL).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

      <div
        className="sidebar-search"
        title={
          "Narrow the tree to entries whose cluster, namespace, pg cluster, user, or database name\n" +
          "contains the typed text. Use \"/\" to chain levels:\n" +
          "    icecream/claude         → cluster icecream → namespace claude\n" +
          "    claude/postgres-cluster → namespace claude → pg-cluster postgres-cluster\n" +
          "The first segment can match any depth — there's no anchor."
        }
      >
        <Icon name="search" size={12} />
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Find: name  or  parent/child  (e.g. icecream/claude)"
          onKeyDown={e => { if (e.key === "Escape") setQuery(""); }}
        />
        {query && (
          <button onClick={() => setQuery("")} title="Clear filter (Esc)" style={{ color: "var(--fg-mute)" }}>
            <Icon name="x" size={12} />
          </button>
        )}
        {!query && <span className="kbd" title="Press / to focus">/</span>}
      </div>

      <div className="tree" ref={treeRef}>
        {ctxEntries.length === 0 && (
          <div className="tree-row" style={{ color: "var(--fg-mute)", fontStyle: "italic", cursor: "default", paddingLeft: 20 }}>
            <span className="label">Loading contexts…</span>
          </div>
        )}
        {ctxEntries.map(([cn, c]) => {
          if (!showK(cn)) return null;
          const ctxOpen = openCtx.has(cn);
          const nsList  = (c.namespaces || [])
            .filter(n => !hideEmptyNs || (n.clusters || []).length > 0)
            .filter(n => showN(cn, n.name));
          return (
            <React.Fragment key={cn}>
              <TreeRow
                depth={0}
                open={ctxOpen}
                hasChildren
                glyph={<Icon name="cluster" size={13} />}
                label={highlight(cn, segments)}
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
                const clusters = (n.clusters || []).filter(cl => showC(cn, n.name, cl.name));
                return (
                  <React.Fragment key={nsKey}>
                    <TreeRow
                      depth={1}
                      open={nsOpen}
                      hasChildren={(n.clusters || []).length > 0}
                      glyph={<Icon name="ns" size={13} />}
                      label={highlight(n.name, segments)}
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
                            label={highlight(cl.name, segments)}
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
                              {(cl.users || []).filter(u => showU(cn, n.name, cl.name, u.name)).map(u => {
                                const userKey  = `${clKey}::${u.name}`;
                                const userOpen = openUser.has(userKey);
                                const ctxs     = u.contextNames || cl.contextNames || n.contextNames || c.contextNames || [];
                                // Only this user's databases (from Database CR
                                // owner). Untagged entries are shown to all
                                // users as a fallback for legacy clusters.
                                const userDbs  = (cl.databases || [])
                                  .filter(d => !d.owner || d.owner === u.name)
                                  .filter(d => showD(cn, n.name, cl.name, u.name, d.name))
                                  .map(d => d.name);
                                return (
                                  <React.Fragment key={u.name}>
                                    <TreeRow
                                      depth={3}
                                      open={userOpen}
                                      hasChildren={userDbs.length > 0}
                                      glyph={<Icon name="key" size={12} />}
                                      label={highlight(u.name, segments)}
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
                                          <span className="label">{highlight(dbName, segments)}</span>
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
