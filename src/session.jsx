/* ============================================================
   Session pane — minimalist psql-like REPL.
   No editor / results split. Just a scrolling log + a prompt.
   ============================================================ */

const { useState: sUseState, useRef: sUseRef, useEffect: sUseEffect,
        useMemo: sUseMemo, useLayoutEffect } = React;

// ---------- Lexer for the highlighter shown on the prompt line ----------
const KW_SET = new Set(window.SQL_KEYWORDS);
const FN_SET = new Set(window.SQL_FUNCTIONS);

function highlightSql(src) {
  const out = [];
  const push = (cls, text) => out.push({ cls, text });
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "-" && src[i+1] === "-") {
      let j = src.indexOf("\n", i); if (j < 0) j = src.length;
      push("tok-com", src.slice(i, j)); i = j; continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'" && src[j+1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      push("tok-str", src.slice(i, j)); i = j; continue;
    }
    if (ch === "\\" && (i === 0 || src[i-1] === "\n")) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z+?]/.test(src[j])) j++;
      push("tok-meta", src.slice(i, j)); i = j; continue;
    }
    if (/\d/.test(ch)) {
      let j = i;
      while (j < src.length && /[\d._]/.test(src[j])) j++;
      push("tok-num", src.slice(i, j)); i = j; continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const lc = word.toLowerCase();
      let cls = null;
      if (KW_SET.has(lc)) cls = "tok-kw";
      else if (FN_SET.has(lc)) cls = "tok-fn";
      push(cls, word); i = j; continue;
    }
    if (/[=<>!+\-*\/(),;.]/.test(ch)) { push("tok-op", ch); i++; continue; }
    push(null, ch); i++;
  }
  return out;
}

function HighlightedInline({ src }) {
  const tokens = sUseMemo(() => highlightSql(src), [src]);
  return (
    <>
      {tokens.map((t, i) =>
        t.cls ? <span key={i} className={t.cls}>{t.text}</span>
              : <React.Fragment key={i}>{t.text}</React.Fragment>
      )}
    </>
  );
}

// ---------- Autocomplete suggestions ----------
function commonPrefix(strings) {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (prefix && !strings[i].toLowerCase().startsWith(prefix.toLowerCase())) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) break;
  }
  return prefix;
}

function getAutocompleteSuggestions(text, caret, db) {
  let i = caret - 1;
  while (i >= 0 && /[a-zA-Z0-9_\\.]/.test(text[i])) i--;
  const start = i + 1;
  const fragment = text.slice(start, caret);
  if (!fragment) return { fragment: "", items: [], start: caret };

  if (fragment.startsWith("\\")) {
    const items = [];
    for (const m of window.PSQL_META) {
      if (m.cmd.startsWith(fragment))
        items.push({ kind: "meta", name: m.cmd, hint: m.desc });
    }
    return { fragment, items: items.slice(0, 10), start };
  }

  const schemas = window.SCHEMAS[db] || {};

  // Schema-qualified name: "public.u" → look only inside the public schema
  // for relations starting with "u", and the replacement range starts AFTER
  // the dot so we don't re-type "public.".
  const dot = fragment.indexOf(".");
  if (dot >= 0) {
    const schemaName = fragment.slice(0, dot);
    const namePrefix = fragment.slice(dot + 1);
    const lc = namePrefix.toLowerCase();
    const items = [];
    const sch  = schemas[schemaName];
    if (sch) {
      for (const t of sch.tables || []) {
        if (t.name.toLowerCase().startsWith(lc))
          items.push({ kind: "table", name: t.name, hint: `${schemaName} · ${(t.rows || 0).toLocaleString()} rows` });
      }
      for (const v of sch.views || []) {
        if (v.toLowerCase().startsWith(lc))
          items.push({ kind: "view", name: v, hint: schemaName });
      }
      for (const f of sch.functions || []) {
        if (f.toLowerCase().startsWith(lc))
          items.push({ kind: "func", name: f, hint: schemaName });
      }
    }
    return { fragment: namePrefix, items, start: start + dot + 1 };
  }

  const lc = fragment.toLowerCase();
  const items = [];

  for (const [schemaName, sch] of Object.entries(schemas)) {
    for (const t of sch.tables || []) {
      if (t.name.toLowerCase().startsWith(lc))
        items.push({ kind: "table", name: t.name, hint: `${schemaName} · ${(t.rows || 0).toLocaleString()} rows` });
    }
    for (const v of sch.views || []) {
      if (v.toLowerCase().startsWith(lc))
        items.push({ kind: "view", name: v, hint: schemaName });
    }
    for (const f of sch.functions || []) {
      if (f.toLowerCase().startsWith(lc))
        items.push({ kind: "func", name: f, hint: schemaName });
    }
    for (const t of sch.tables || []) {
      for (const c of t.cols) {
        if (c.name.toLowerCase().startsWith(lc) && c.name.toLowerCase() !== lc)
          items.push({ kind: "col", name: c.name, hint: `${t.name}.${c.name} · ${c.type}` });
      }
    }
  }

  for (const kw of window.SQL_KEYWORDS)
    if (kw.startsWith(lc)) items.push({ kind: "kw", name: kw, hint: "" });
  for (const fn of window.SQL_FUNCTIONS)
    if (fn.startsWith(lc)) items.push({ kind: "fn", name: fn, hint: "function" });

  // Dedup but DON'T truncate — the common-prefix calc in the Tab handler
  // must see every match, otherwise it can resolve to a too-long prefix
  // (e.g. cutting off "users" after a dozen "user_*" tables would yield
  // "user_" instead of the correct "user"). The popup's CSS handles
  // overflow with a scrollbar.
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = it.kind + ":" + it.name;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return { fragment, items: out, start };
}

function humanBytes(n) {
  const u = ["B","kB","MB","GB","TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${u[i]}`;
}

// ---------- psql-style ASCII table renderer ----------
function isNumericType(t) {
  return /int|serial|bigint|smallint|numeric|decimal|double|real|oid/.test(t || "");
}

function renderPsqlTable(cols, rows, title) {
  // cols: [{name, type}], rows: array of objects keyed by col name
  if (rows.length === 0) {
    return { lines: [title ? title : "", "(0 rows)"].filter(Boolean), cols, rows };
  }
  const widths = cols.map(c => {
    let w = c.name.length;
    for (const r of rows) {
      const v = r[c.name];
      const s = v === null || v === undefined ? "" : String(v);
      if (s.length > w) w = s.length;
    }
    return Math.min(60, Math.max(3, w));
  });
  const pad = (s, w, right) => {
    s = String(s ?? "");
    if (s.length > w) s = s.slice(0, w - 1) + "…";
    return right ? s.padStart(w, " ") : s.padEnd(w, " ");
  };

  const header = " " + cols.map((c, i) => pad(c.name, widths[i], false)).join(" | ") + " ";
  const sep = widths.map(w => "-".repeat(w + 2)).join("+");
  const dataLines = rows.map(r =>
    " " + cols.map((c, i) => pad(
      r[c.name] === null || r[c.name] === undefined ? "" : r[c.name],
      widths[i],
      isNumericType(c.type)
    )).join(" | ") + " "
  );
  const footer = `(${rows.length} row${rows.length === 1 ? "" : "s"})`;
  return {
    lines: [title || null, header, sep, ...dataLines, "", footer].filter(x => x !== null),
    cols, rows, widths,
  };
}

function execMeta(cmd, ctx) {
  const trimmed = cmd.trim().replace(/;\s*$/, "");
  const schemas = window.SCHEMAS[ctx.db] || {};
  if (/^\\dt\+?$/.test(trimmed)) {
    const verbose = trimmed.endsWith("+");
    const rows = [];
    for (const [sn, s] of Object.entries(schemas)) {
      for (const t of s.tables || []) {
        rows.push(verbose
          ? { Schema: sn, Name: t.name, Type: "table", Owner: ctx.user, Size: humanBytes(t.rows * 240), Description: "" }
          : { Schema: sn, Name: t.name, Type: "table", Owner: ctx.user });
      }
    }
    const cols = verbose
      ? [{name:"Schema"},{name:"Name"},{name:"Type"},{name:"Owner"},{name:"Size"},{name:"Description"}]
      : [{name:"Schema"},{name:"Name"},{name:"Type"},{name:"Owner"}];
    return { kind: "table", cols, rows, title: "List of relations" };
  }
  if (/^\\dv$/.test(trimmed)) {
    const rows = [];
    for (const [sn, s] of Object.entries(schemas))
      for (const v of s.views || []) rows.push({ Schema: sn, Name: v, Type: "view", Owner: ctx.user });
    return { kind: "table", cols: [{name:"Schema"},{name:"Name"},{name:"Type"},{name:"Owner"}], rows, title: "List of relations" };
  }
  if (/^\\df$/.test(trimmed)) {
    const rows = [];
    for (const [sn, s] of Object.entries(schemas))
      for (const f of s.functions || []) rows.push({ Schema: sn, Name: f, "Result data type": "—", "Argument types": "—" });
    return { kind: "table", cols: [{name:"Schema"},{name:"Name"},{name:"Result data type"},{name:"Argument types"}], rows, title: "List of functions" };
  }
  if (/^\\dn$/.test(trimmed)) {
    const rows = Object.keys(schemas).map(n => ({ Name: n, Owner: ctx.user }));
    return { kind: "table", cols: [{name:"Name"},{name:"Owner"}], rows, title: "List of schemas" };
  }
  if (/^\\du$/.test(trimmed)) {
    const rows = (ctx.allUsers || []).map(u => ({
      "Role name": u.name,
      "Attributes": u.role === "superuser" ? "Superuser" : "Login",
      "Member of": "—",
    }));
    return { kind: "table", cols: [{name:"Role name"},{name:"Attributes"},{name:"Member of"}], rows, title: "List of roles" };
  }
  if (/^\\l$/.test(trimmed)) {
    const dbs = (ctx.allDatabases || [ctx.db]).map(d => ({
      Name: d, Owner: "postgres", Encoding: "UTF8", Collate: "en_US.utf8",
    }));
    return { kind: "table", cols: [{name:"Name"},{name:"Owner"},{name:"Encoding"},{name:"Collate"}], rows: dbs, title: "List of databases" };
  }
  const dMatch = trimmed.match(/^\\d\+?\s+(\S+)$/);
  if (dMatch) {
    const arg = dMatch[1];
    // Support schema-qualified names like "public.users". When the arg
    // contains a dot, restrict the lookup to that schema; otherwise scan
    // every schema (psql's search-path-like behavior).
    const dot = arg.indexOf(".");
    const wantSchema = dot >= 0 ? arg.slice(0, dot) : null;
    const wantName   = dot >= 0 ? arg.slice(dot + 1) : arg;

    for (const [sn, s] of Object.entries(schemas)) {
      if (wantSchema && sn !== wantSchema) continue;
      const t = (s.tables || []).find(t => t.name === wantName);
      if (t) {
        return {
          kind: "table",
          cols: [{name:"Column"},{name:"Type"},{name:"Nullable"},{name:"Default"}],
          rows: t.cols.map(c => ({
            Column: c.name, Type: c.type,
            Nullable: c.pk ? "not null" : "",
            Default: c.pk && c.type === "bigint" ? `nextval('${t.name}_id_seq')` : "",
          })),
          title: `Table "${sn}.${t.name}"`,
        };
      }
      if ((s.views || []).includes(wantName)) {
        return {
          kind: "table",
          cols: [{name:"Column"},{name:"Type"}],
          rows: [],
          title: `View "${sn}.${wantName}" (column introspection not cached)`,
        };
      }
    }
    return { kind: "error", message: `Did not find any relation named "${arg}".` };
  }
  if (/^\\timing$/.test(trimmed)) return { kind: "notice", message: "Timing is on." };
  if (/^\\x$/.test(trimmed))      return { kind: "notice", message: "Expanded display is on." };
  if (/^\\\?$/.test(trimmed)) {
    return {
      kind: "table",
      cols: [{name:"Command"},{name:"Description"}],
      rows: window.PSQL_META.map(m => ({ Command: m.cmd, Description: m.desc })),
      title: "psql meta-commands",
    };
  }
  if (/^\\q$/.test(trimmed))      return { kind: "quit" };
  return { kind: "error", message: `Invalid command \\${trimmed.slice(1)}. Try \\? for help.` };
}

// Decide whether the user's buffer is a "complete" statement to send.
function isCompleteStatement(text) {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("\\")) return true;          // meta commands run on Enter
  if (t.endsWith(";")) return true;
  return false;
}

// ---------- Result rendering ----------
function ResultBlock({ result }) {
  if (!result) return null;
  if (result.kind === "table") {
    const { lines, cols, rows, widths } = renderPsqlTable(result.cols, result.rows, result.title);
    // Render header/sep/data with subtle coloring.
    const headerIx = result.title ? 1 : 0;
    return (
      <div className="psql-table" style={{ overflowX: "auto" }}>
        {lines.map((line, i) => {
          if (i === headerIx)        return <div key={i} className="t-head">{line}</div>;
          if (i === headerIx + 1)    return <div key={i} className="t-sep">{line}</div>;
          if (i === 0 && result.title) return <div key={i} className="t-title">{line}</div>;
          if (line === "")           return <div key={i}>&nbsp;</div>;
          if (line.startsWith("("))  return <div key={i} className="t-foot">{line}</div>;
          return <div key={i} className="t-row">{line}</div>;
        })}
      </div>
    );
  }
  if (result.kind === "explain") {
    return <div className="psql-table">{result.lines.map((l, i) => <div key={i}>{l}</div>)}</div>;
  }
  if (result.kind === "command") return <div className="psql-line cmd">{result.message}</div>;
  if (result.kind === "notice")  return <div className="psql-line notice">{result.message}</div>;
  if (result.kind === "error")   return <div className="psql-line err">ERROR:  {result.message}</div>;
  if (result.kind === "noop")    return null;
  return null;
}

// ---------- The Session (one tab) ----------
function Session({ tab, onUpdateTab }) {
  const [buffer, setBuffer] = sUseState("");
  const [hIdx, setHIdx] = sUseState(-1);     // history navigation index
  const [hStash, setHStash] = sUseState("");  // stash buffer when entering history nav
  const [acState, setAcState] = sUseState({ open: false, items: [], idx: 0, start: 0 });
  const [acPlacement, setAcPlacement] = sUseState("above");  // "above" | "below"
  const [acMaxH, setAcMaxH] = sUseState(280);                // px, computed at open
  const lastTabRef = sUseRef(0);
  const acListRef  = sUseRef(null);
  // Set true the moment a keyboard nav advances the selection; cleared by
  // any real mousemove. Suppresses spurious mouseEnter events that fire
  // when the list scrolls under a stationary cursor (which would otherwise
  // snap the selection to whichever row drifts under the mouse).
  const kbdNavRef  = sUseRef(false);

  const taRef = sUseRef(null);
  const logRef = sUseRef(null);
  const wrapRef = sUseRef(null);

  // Auto-scroll log on update
  sUseEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab.log?.length, buffer]);

  // Focus prompt when tab changes or clicked anywhere in the session
  sUseEffect(() => { taRef.current?.focus(); }, [tab.id]);

  const ctx = sUseMemo(() => ({
    db: tab.db, cluster: tab.cluster, namespace: tab.namespace,
    contextName: tab.context, user: tab.user,
    allUsers: tab.allUsers || [],
    allDatabases: tab.allDatabases || [],
  }), [tab]);

  const promptPrefix = sUseMemo(() => {
    // Continuation prompt when buffer has unterminated parens/quotes/incomplete
    const t = buffer.trim();
    if (t.length === 0) return `${tab.db}=>`;
    if (t.startsWith("\\")) return `${tab.db}=>`;
    if (t.endsWith(";")) return `${tab.db}=>`;
    // open paren count
    let parens = 0;
    let inStr = false;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === "'") inStr = !inStr;
      else if (!inStr && buffer[i] === "(") parens++;
      else if (!inStr && buffer[i] === ")") parens--;
    }
    if (parens > 0) return `${tab.db}(>`;
    if (inStr) return `${tab.db}'>`;
    return `${tab.db}->`;
  }, [buffer, tab.db]);

  const run = async (text) => {
    const sql = text.trim();
    if (!sql) return;

    setBuffer("");
    setHIdx(-1);

    // Meta-commands (\ prefix) are handled client-side using the schema cache.
    if (sql.startsWith("\\")) {
      const result = execMeta(sql, ctx);
      if (result.kind === "quit") { onUpdateTab({ _close: true }); return; }
      const log = (tab.log || []).slice();
      log.push({ kind: "prompt", db: tab.db, text: sql });
      log.push({ kind: "result", result });
      if (tab.timing) log.push({ kind: "timing", ms: (0.1 + Math.random() * 2).toFixed(1) });
      onUpdateTab({ log, history: [sql, ...(tab.history || []).filter(h => h !== sql)].slice(0, 200) });
      return;
    }

    // Real SQL: append prompt immediately, then await the IPC query.
    const logBefore = [...(tab.log || []), { kind: "prompt", db: tab.db, text: sql }];
    onUpdateTab({ log: logBefore, history: [sql, ...(tab.history || []).filter(h => h !== sql)].slice(0, 200) });

    const t0 = Date.now();
    try {
      const res = await window.cloudpg.pg.query(tab.id, sql);
      const ms  = (Date.now() - t0).toString();

      let result;
      if (res.error) {
        result = {
          kind: "error",
          message: res.error + (res.where ? "\n" + res.where : "") + (res.code ? " (" + res.code + ")" : ""),
        };
      } else if (res.rows && res.rows.length > 0) {
        const cols = (res.fields || []).map(f => ({ name: f.name, type: "" }));
        result = { kind: "table", cols, rows: res.rows };
      } else if (res.command) {
        result = { kind: "command", message: `${res.command}${res.rowCount != null ? " " + res.rowCount : ""}` };
      } else {
        result = { kind: "command", message: "OK" };
      }

      const newLog = [...logBefore, { kind: "result", result }];
      if (tab.timing) newLog.push({ kind: "timing", ms });
      onUpdateTab({ log: newLog });
    } catch (err) {
      const newLog = [...logBefore, { kind: "result", result: { kind: "error", message: err.message } }];
      onUpdateTab({ log: newLog });
    }
  };

  // Autocomplete popup placement. Pick whichever side of the prompt has more
  // room inside the scrollable log, then size the popup to fit that room so
  // it never gets clipped — instead it grows a scrollbar.
  const AC_MARGIN = 12;       // visual breathing room from log edge
  const AC_MIN_H  = 120;
  const AC_MAX_H  = 420;

  const placeAC = () => {
    const ta = taRef.current, log = logRef.current;
    if (!ta || !log) return;
    const tr = ta.getBoundingClientRect();
    const lr = log.getBoundingClientRect();
    const spaceAbove = tr.top    - lr.top    - AC_MARGIN;
    const spaceBelow = lr.bottom - tr.bottom - AC_MARGIN;
    const placement  = spaceAbove >= spaceBelow ? "above" : "below";
    const room       = placement === "above" ? spaceAbove : spaceBelow;
    setAcPlacement(placement);
    setAcMaxH(Math.max(AC_MIN_H, Math.min(AC_MAX_H, room)));
  };

  // Keep the active item visible as the user arrow-keys through a long
  // list. Compute scroll position from the row's offsetTop within
  // .ac-list (which is position: relative for this purpose) and write
  // only to list.scrollTop — never call scrollIntoView, which would also
  // scroll .repl-log underneath us. useLayoutEffect runs before paint so
  // the user never sees an intermediate position.
  useLayoutEffect(() => {
    if (!acState.open) return;
    const list = acListRef.current;
    const row  = list?.children?.[acState.idx];
    if (!list || !row) return;
    const rowTop    = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    const viewTop   = list.scrollTop;
    const viewBot   = viewTop + list.clientHeight;
    if (rowTop < viewTop)         list.scrollTop = rowTop;
    else if (rowBottom > viewBot) list.scrollTop = rowBottom - list.clientHeight;
  }, [acState.idx, acState.open]);

  // Insert `item` into the buffer, replacing the autocomplete fragment that
  // begins at `start`. Used both when the popup is open (start = acState.start)
  // and when Tab silently completes a single match.
  const acceptAt = (item, start) => {
    const ta = taRef.current; if (!ta) return;
    const before = buffer.slice(0, start);
    const after  = buffer.slice(ta.selectionEnd);
    const insert = item.name + (item.kind === "fn" || item.kind === "func" ? "(" : "");
    const next   = before + insert + after;
    setBuffer(next);
    const newCaret = before.length + insert.length;
    setAcState(s => ({ ...s, open: false }));
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(newCaret, newCaret);
    });
  };
  const accept = (item) => acceptAt(item, acState.start);

  const onChange = (e) => {
    setBuffer(e.target.value);
    setHIdx(-1);
    // Typing means the user is composing; if a popup is open from a
    // previous double-tab, dismiss it so they can keep editing freely.
    if (acState.open) setAcState(s => ({ ...s, open: false }));
  };

  const onKeyDown = (e) => {
    // Autocomplete navigation (only when popup is open). Tab accepts the
    // highlighted item; Enter closes and falls through to submit.
    if (acState.open) {
      if (e.key === "ArrowDown") { e.preventDefault(); kbdNavRef.current = true; setAcState(s => ({ ...s, idx: Math.min(s.items.length - 1, s.idx + 1) })); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); kbdNavRef.current = true; setAcState(s => ({ ...s, idx: Math.max(0, s.idx - 1) })); return; }
      if (e.key === "Tab")       { e.preventDefault(); accept(acState.items[acState.idx]); return; }
      if (e.key === "Enter")     { e.preventDefault(); accept(acState.items[acState.idx]); return; }
      if (e.key === "Escape")    { e.preventDefault(); setAcState(s => ({ ...s, open: false })); return; }
    }

    // Tab (popup closed): bash-style completion.
    //   1 match            → complete silently
    //   N matches, prefix  → extend to longest common prefix
    //   N matches, no ext. → first Tab does nothing; second Tab (<500ms) shows popup
    if (e.key === "Tab") {
      e.preventDefault();
      const c = e.currentTarget.selectionStart;
      const { fragment, items, start } = getAutocompleteSuggestions(buffer, c, tab.db);

      if (items.length === 0) { lastTabRef.current = Date.now(); return; }

      if (items.length === 1) {
        acceptAt(items[0], start);
        lastTabRef.current = 0;
        return;
      }

      const now = Date.now();
      const isDoubleTab = now - lastTabRef.current < 500;
      lastTabRef.current = now;

      const cp = commonPrefix(items.map(i => i.name));
      if (cp.length > fragment.length) {
        const before = buffer.slice(0, start);
        const after  = buffer.slice(c);
        setBuffer(before + cp + after);
        const newCaret = before.length + cp.length;
        queueMicrotask(() => {
          const ta = taRef.current;
          ta?.focus();
          ta?.setSelectionRange(newCaret, newCaret);
        });
        return;
      }

      if (isDoubleTab) {
        setAcState({ open: true, items, idx: 0, start });
        placeAC();
      }
      // single tab with no extension possible → silently armed for next tab
      return;
    }
    // Enter to submit (Shift+Enter = newline; meta-command starting with \ submits immediately)
    if (e.key === "Enter" && !e.shiftKey) {
      if (isCompleteStatement(buffer)) {
        e.preventDefault();
        run(buffer);
      } else if (buffer.trim() === "") {
        // Degenerate "hit Enter on an empty prompt" — psql echoes the
        // prompt to the scrollback and reprints a fresh one below, instead
        // of just growing the textarea with an orphaned blank line.
        e.preventDefault();
        onUpdateTab({ log: [...(tab.log || []), { kind: "prompt", db: tab.db, text: "" }] });
      }
      // else: incomplete multi-line statement — let Enter insert a newline
      return;
    }
    // History navigation only when caret is at the very start (Up) or end (Down)
    const ta = e.currentTarget;
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === buffer.length && ta.selectionEnd === buffer.length;
    if (e.key === "ArrowUp" && atStart) {
      const hist = tab.history || [];
      if (hist.length === 0) return;
      e.preventDefault();
      if (hIdx === -1) setHStash(buffer);
      const next     = Math.min(hist.length - 1, hIdx + 1);
      const newBuf   = hist[next];
      setHIdx(next);
      setBuffer(newBuf);
      // Shell-style: cursor at end of the recalled command.
      queueMicrotask(() => taRef.current?.setSelectionRange(newBuf.length, newBuf.length));
      return;
    }
    if (e.key === "ArrowDown" && atEnd) {
      const hist = tab.history || [];
      if (hIdx === -1) return;
      e.preventDefault();
      const next   = hIdx - 1;
      const newBuf = next === -1 ? hStash : hist[next];
      setHIdx(next);
      setBuffer(newBuf);
      queueMicrotask(() => taRef.current?.setSelectionRange(newBuf.length, newBuf.length));
      return;
    }
    // Cmd+L clear screen
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      onUpdateTab({ log: [{ kind: "notice", text: "(cleared)" }] });
      return;
    }
  };

  // Focus textarea on a *click* in the log area (real psql-y feel) while
  // still letting the user drag-select log content for copy. Old version
  // focused on mousedown, which interrupted selection before it could
  // begin. Now we track the mousedown point and only steal focus on mouseup
  // when the pointer didn't move (a click, not a drag) and nothing got
  // selected.
  const dragRef = sUseRef(null);
  const onSessionMouseDown = (e) => {
    dragRef.current = { x: e.clientX, y: e.clientY };
  };
  const onSessionMouseUp = (e) => {
    const start = dragRef.current;
    dragRef.current = null;
    if (!start) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moved > 3) return;  // drag → user is selecting; leave selection alone
    // Defer one tick so double-click word selection has time to register.
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      taRef.current?.focus();
    }, 0);
  };

  return (
    <div className="repl" ref={wrapRef} onMouseDown={onSessionMouseDown} onMouseUp={onSessionMouseUp}>
      <div className="repl-log" ref={logRef}>
        {(tab.log || []).map((e, i) => {
          if (e.kind === "welcome") return <div key={i} className="psql-line dim">{e.text}</div>;
          if (e.kind === "notice")  return <div key={i} className="psql-line notice">{e.text}</div>;
          if (e.kind === "ok")      return <div key={i} className="psql-line ok">{e.text}</div>;
          if (e.kind === "info")    return <div key={i} className="psql-line">{e.text}</div>;
          if (e.kind === "timing")  return <div key={i} className="psql-line dim">Time: {e.ms} ms</div>;
          if (e.kind === "prompt") {
            const lines = e.text.split("\n");
            return (
              <div key={i} className="psql-line cmd-echo">
                {lines.map((ln, j) => (
                  <div key={j}>
                    <span className="prompt-prefix">
                      {j === 0 ? `${e.db}=>` : `${e.db}->`}
                    </span>{" "}
                    <span><HighlightedInline src={ln} /></span>
                  </div>
                ))}
              </div>
            );
          }
          if (e.kind === "result") return <ResultBlock key={i} result={e.result} />;
          return null;
        })}

        {/* The active prompt lives at the tail of the log so it sits
            immediately after the last output line, like psql. */}
        <div className="repl-prompt">
          <span className="prompt-prefix">{promptPrefix}</span>
          <div className="prompt-input">
            <pre className="prompt-hl" aria-hidden="true">
              <HighlightedInline src={buffer} />
              {"\n"}
            </pre>
            <textarea
              ref={taRef}
              value={buffer}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onClick={() => setAcState(s => ({ ...s, open: false }))}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              rows={Math.min(8, Math.max(1, buffer.split("\n").length))}
              placeholder={tab.log?.length ? "" : "Type SQL or a \\meta command. Enter to run · Shift+Enter for newline · Tab for autocomplete"}
            />
            {acState.open && (
              <div
                className={`ac-pop ac-pop-${acPlacement}`}
                style={{ maxHeight: acMaxH }}
              >
                <div
                  className="ac-list"
                  ref={acListRef}
                  onMouseMove={() => { kbdNavRef.current = false; }}
                >
                  {acState.items.map((it, i) => (
                    <div
                      key={it.kind + it.name}
                      className={`ac-item${i === acState.idx ? " is-active" : ""}`}
                      onMouseDown={(e) => { e.preventDefault(); accept(it); }}
                      onMouseEnter={() => {
                        // Ignore mouseEnter that fires because the list
                        // scrolled under a stationary cursor — only honor it
                        // when the mouse has actually moved.
                        if (kbdNavRef.current) return;
                        setAcState(s => ({ ...s, idx: i }));
                      }}
                    >
                      <span className="kind">{it.kind}</span>
                      <span className="name">{it.name}</span>
                      {it.hint && <span className="hint">{it.hint}</span>}
                    </div>
                  ))}
                </div>
                <div className="ac-foot">
                  <span><kbd>Tab</kbd> accept</span>
                  <span><kbd>↑↓</kbd> nav</span>
                  <span><kbd>Esc</kbd> close</span>
                  <span style={{ marginLeft: "auto" }}>{acState.items.length}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

window.Session = Session;
