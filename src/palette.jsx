/* ============================================================
   Cmd-K quick switcher with facet filters (ctx / ns / user / db).
   Filters are faceted: setting one narrows the options for the others.
   Text input also fuzzy-matches across all fields.
   ============================================================ */

const { useState: pUseState, useEffect: pUseEffect, useMemo: pUseMemo, useRef: pUseRef } = React;

function flattenTargets() {
  const out = [];
  for (const [cn, c] of Object.entries(window.CONTEXTS)) {
    for (const n of c.namespaces) {
      for (const cl of n.clusters) {
        for (const u of cl.users) {
          for (const db of (u.databases || [])) {
            out.push({
              key: `${cn}::${n.name}::${cl.name}::${u.name}::${db}`,
              context: cn,
              namespace: n.name,
              cluster: cl.name,
              user: u.name,
              role: u.role,
              db,
              phase: cl.phase,
              users: cl.users,
              databases: cl.databases,
              pgVersion: cl.pgVersion,
              ready: cl.ready,
              instances: cl.instances,
            });
          }
        }
      }
    }
  }
  return out;
}

function fuzzy(query, target) {
  if (!query) return { score: 1, hits: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  const hits = [];
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { hits.push(i); qi++; }
  }
  if (qi < q.length) return null;
  const span = hits[hits.length - 1] - hits[0];
  const score = 1000 - span - hits[0];
  return { score, hits };
}

const FACETS = [
  { id: "context",   label: "ctx",  icon: "cluster" },
  { id: "namespace", label: "ns",   icon: "ns" },
  { id: "cluster",   label: "pg",   icon: "db" },
  { id: "user",      label: "user", icon: "user" },
  { id: "db",        label: "db",   icon: "db" },
];

function FacetChip({ facet, value, open, onOpen, onClear, options, onSelect, disabled }) {
  return (
    <div className={`facet-chip${value ? " is-set" : ""}${open ? " is-open" : ""}${disabled ? " is-disabled" : ""}`}>
      <button
        type="button"
        className="facet-trigger"
        onClick={(e) => { e.stopPropagation(); if (!disabled) onOpen(facet.id); }}
      >
        <Icon name={facet.icon} size={11} />
        <span className="lab">{facet.label}</span>
        {value
          ? <span className="val">{value}</span>
          : <span className="add">+ any</span>}
        <Icon name="chev-down" size={10} />
      </button>
      {value && (
        <button
          type="button"
          className="facet-clear"
          onClick={(e) => { e.stopPropagation(); onClear(facet.id); }}
          title={`Clear ${facet.label} filter`}
        >
          <Icon name="x" size={9} />
        </button>
      )}
      {open && (
        <div className="facet-pop" onClick={e => e.stopPropagation()}>
          <div className="facet-pop-head">{facet.label}</div>
          {options.length === 0 && (
            <div className="facet-pop-empty">No matches with current filters</div>
          )}
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`facet-pop-row${opt.value === value ? " is-selected" : ""}`}
              onClick={(e) => { e.stopPropagation(); onSelect(facet.id, opt.value); }}
            >
              <span className="lab">{opt.value}</span>
              <span className="count">{opt.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CommandPalette({ open, onClose, onPick, recents = [] }) {
  const [q, setQ] = pUseState("");
  const [idx, setIdx] = pUseState(0);
  const [filters, setFilters] = pUseState({});
  const [openFacet, setOpenFacet] = pUseState(null);
  const inputRef = pUseRef(null);
  const listRef = pUseRef(null);
  const rootRef = pUseRef(null);

  pUseEffect(() => {
    if (open) { setQ(""); setIdx(0); setFilters({}); setOpenFacet(null);
      setTimeout(() => inputRef.current?.focus(), 10); }
  }, [open]);

  const allTargets = pUseMemo(flattenTargets, []);

  // Apply facet filters first (AND). Returns the subset of targets.
  const passesFilters = (t, filters) => {
    for (const [k, v] of Object.entries(filters)) {
      if (!v) continue;
      if (t[k] !== v) return false;
    }
    return true;
  };

  const filteredByFacets = pUseMemo(
    () => allTargets.filter(t => passesFilters(t, filters)),
    [allTargets, filters]
  );

  // For each facet, compute distinct option values **when the OTHER
  // filters are applied** — classic faceted search.
  const facetOptions = pUseMemo(() => {
    const out = {};
    for (const f of FACETS) {
      const others = { ...filters };
      delete others[f.id];
      const scope = allTargets.filter(t => passesFilters(t, others));
      const counts = new Map();
      for (const t of scope) {
        const v = t[f.id];
        counts.set(v, (counts.get(v) || 0) + 1);
      }
      out[f.id] = [...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }));
    }
    return out;
  }, [allTargets, filters]);

  // Apply text search on top of facet filtering.
  const results = pUseMemo(() => {
    if (!q) {
      const recentSet = new Set(recents.map(r => r.key));
      const grouped = [
        { group: "Recent", items: filteredByFacets.filter(t => recentSet.has(t.key)) },
        { group: filteredByFacets.length === allTargets.length ? "All targets" : `${filteredByFacets.length} match${filteredByFacets.length===1?"":"es"}`,
          items: filteredByFacets.filter(t => !recentSet.has(t.key)).slice(0, 40) },
      ].filter(g => g.items.length);
      return grouped;
    }
    const scored = [];
    for (const t of filteredByFacets) {
      const haystack = `${t.context} ${t.namespace} ${t.cluster} ${t.user} ${t.db} ${t.role}`;
      const m = fuzzy(q, haystack);
      if (m) scored.push({ target: t, ...m });
    }
    scored.sort((a, b) => b.score - a.score);
    return [{ group: `${scored.length} match${scored.length===1?"":"es"}`,
              items: scored.slice(0, 40).map(s => s.target) }];
  }, [q, filteredByFacets, recents, allTargets.length]);

  const flat = pUseMemo(() => results.flatMap(g => g.items), [results]);

  pUseEffect(() => { setIdx(0); }, [q, filters]);

  pUseEffect(() => {
    const node = listRef.current?.querySelector(".cmdk-item.is-active");
    if (node) node.scrollIntoView({ block: "nearest" });
  }, [idx]);

  // Close any open facet popover when clicking elsewhere inside the palette.
  pUseEffect(() => {
    if (!openFacet) return;
    const onDoc = (e) => {
      const inFacet = e.target.closest?.(".facet-chip");
      if (!inFacet) setOpenFacet(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openFacet]);

  if (!open) return null;

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(flat.length - 1, i + 1)); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = flat[idx];
      if (pick) onPick(pick);
    }
    // Backspace on empty query clears the last set facet
    if (e.key === "Backspace" && q === "") {
      const setIds = FACETS.map(f => f.id).filter(id => filters[id]);
      if (setIds.length) {
        e.preventDefault();
        const last = setIds[setIds.length - 1];
        const next = { ...filters }; delete next[last];
        setFilters(next);
      }
    }
  };

  let flatIdx = -1;

  const setFacet = (id, value) => {
    setFilters(f => ({ ...f, [id]: value }));
    setOpenFacet(null);
    inputRef.current?.focus();
  };
  const clearFacet = (id) => {
    setFilters(f => { const n = { ...f }; delete n[id]; return n; });
  };

  return (
    <div className="cmdk-overlay" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={e => e.stopPropagation()} ref={rootRef}>
        <div className="cmdk-input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              Object.values(filters).some(Boolean)
                ? "Search the filtered set…"
                : "Search ctx, namespace, cluster, user, db…"
            }
          />
          <span className="esc">esc</span>
        </div>

        <div className="cmdk-facets">
          <span className="cmdk-facets-label">Filter</span>
          {FACETS.map(f => (
            <FacetChip
              key={f.id}
              facet={f}
              value={filters[f.id] || ""}
              open={openFacet === f.id}
              onOpen={(id) => setOpenFacet(openFacet === id ? null : id)}
              onClear={clearFacet}
              options={facetOptions[f.id] || []}
              onSelect={setFacet}
            />
          ))}
          {Object.values(filters).some(Boolean) && (
            <button
              type="button"
              className="cmdk-clear-all"
              onClick={() => setFilters({})}
              title="Clear all filters"
            >
              clear all
            </button>
          )}
          <span style={{ marginLeft: "auto", fontFamily: "JetBrains Mono, monospace", fontSize: 10.5, color: "var(--fg-mute)" }}>
            {filteredByFacets.length}/{allTargets.length}
          </span>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {results.map(g => (
            <React.Fragment key={g.group}>
              <div className="cmdk-group">{g.group}</div>
              {g.items.map(t => {
                flatIdx++;
                const isActive = flatIdx === idx;
                const phaseVariant = window.PHASE_VARIANT[t.phase] || "warn";
                const myIx = flatIdx;
                return (
                  <div
                    key={t.key}
                    className={`cmdk-item${isActive ? " is-active" : ""}`}
                    onMouseEnter={() => setIdx(myIx)}
                    onClick={() => onPick(t)}
                  >
                    <span className="glyph"><Icon name="db" size={13} /></span>
                    <div className="body">
                      <div className="title">
                        <span style={{ fontFamily: "JetBrains Mono, monospace" }}>
                          <span style={{ color: "var(--fg)" }}>{t.user}</span>
                          <span style={{ color: "var(--fg-mute)" }}>@</span>
                          <span style={{ color: "var(--fg-dim)" }}>{t.cluster}</span>
                          <span style={{ color: "var(--fg-mute)" }}>/</span>
                          <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t.db}</span>
                        </span>
                        <span className={`badge ${phaseVariant}`}><span className="dot" />{t.phase}</span>
                      </div>
                      <div className="sub">
                        <span className="hit">{t.context}</span>
                        <span style={{ color: "var(--fg-faint)" }}> · </span>
                        ns {t.namespace}
                        <span style={{ color: "var(--fg-faint)" }}> · </span>
                        {t.role}
                        <span style={{ color: "var(--fg-faint)" }}> · </span>
                        pg {t.pgVersion}
                      </div>
                    </div>
                    <span className="enter">↵ open</span>
                  </div>
                );
              })}
            </React.Fragment>
          ))}
          {flat.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: "var(--fg-mute)" }}>
              No matches.
              {Object.values(filters).some(Boolean) && (
                <div style={{ marginTop: 8 }}>
                  <button onClick={() => setFilters({})} style={{ color: "var(--accent)", fontSize: 12 }}>
                    Clear filters
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="cmdk-foot">
          <span><span className="key">↑↓</span> navigate</span>
          <span><span className="key">↵</span> open in tab</span>
          <span><span className="key">⌫</span> remove last filter</span>
          <span style={{ marginLeft: "auto" }}>{allTargets.length} targets · {Object.keys(window.CONTEXTS).length} contexts</span>
        </div>
      </div>
    </div>
  );
}

window.CommandPalette = CommandPalette;
window.flattenTargets = flattenTargets;
