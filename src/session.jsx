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
function getAutocompleteSuggestions(text, caret, db) {
  let i = caret - 1;
  while (i >= 0 && /[a-zA-Z0-9_\\.]/.test(text[i])) i--;
  const start = i + 1;
  const fragment = text.slice(start, caret);
  if (!fragment) return { fragment: "", items: [], start: caret };

  const lc = fragment.toLowerCase();
  const items = [];

  if (fragment.startsWith("\\")) {
    for (const m of window.PSQL_META) {
      if (m.cmd.startsWith(fragment))
        items.push({ kind: "meta", name: m.cmd, hint: m.desc });
    }
    return { fragment, items: items.slice(0, 10), start };
  }

  const schemas = window.SCHEMAS[db] || {};
  for (const [schemaName, sch] of Object.entries(schemas)) {
    for (const t of sch.tables || []) {
      if (t.name.toLowerCase().startsWith(lc))
        items.push({ kind: "table", name: t.name, hint: `${schemaName} · ${t.rows.toLocaleString()} rows` });
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

  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = it.kind + ":" + it.name;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= 12) break;
  }
  return { fragment, items: out, start };
}

// ---------- Mock query execution (same as before, db-aware) ----------
function fakeRowFor(col, i, seed = 0) {
  const t = col.type;
  if (col.name === "id" && t === "uuid") {
    const hex = (n) => n.toString(16).padStart(2, "0");
    const s = (seed + i) * 2654435761 >>> 0;
    const b = (n) => hex((s >> (n * 4)) & 0xff);
    return `${b(0)}${b(1)}${b(2)}${b(3)}-${b(4)}${b(5)}-${b(6)}${b(7)}-89ab-${b(0)}${b(1)}${b(2)}${b(3)}${b(4)}${b(5)}`;
  }
  if (t === "uuid") {
    const s = (seed * 31 + i * 7);
    const hex = (n) => ((n * 1103515245 + 12345) >>> 0).toString(16).padStart(8, "0");
    return `${hex(s).slice(0,8)}-${hex(s+1).slice(0,4)}-${hex(s+2).slice(0,4)}-${hex(s+3).slice(0,4)}-${hex(s+4).slice(0,12)}`;
  }
  if (col.name === "email" || t === "citext") {
    const names = ["alice","bob","carol","dan","evelyn","frank","grace","hugo","iris","jules"];
    const doms = ["acme.io","example.com","letters.co","ridge.dev"];
    return `${names[(i + seed) % names.length]}${i+1}@${doms[i % doms.length]}`;
  }
  if (t === "text" || t === "varchar" || /char/.test(t)) {
    if (col.name === "display_name") return ["Alice Reeves","Bob Tan","Carol Vega","Dan Ling","Evelyn Park","Frank Yu","Grace Owen","Hugo Park","Iris Cho","Jules Adler"][(i+seed)%10];
    if (col.name === "country") return ["US","DE","FR","GB","JP","BR","CA","NL"][i % 8];
    if (col.name === "currency") return ["USD","EUR","GBP","JPY"][i % 4];
    if (col.name === "status") return ["paid","open","void","draft","past_due"][i % 5];
    if (col.name === "plan") return ["starter","team","business","enterprise"][i % 4];
    if (col.name === "sku") return `SKU-${(1000 + i * 7).toString().padStart(5,"0")}`;
    if (col.name === "brand") return ["visa","mastercard","amex"][i % 3];
    if (col.name === "last4") return String(1000 + (i * 137) % 9000).padStart(4,"0");
    if (col.name === "name") return ["click","view","signup","purchase","logout"][i % 5];
    if (col.name === "queue") return ["default","emails","webhooks","reports"][i % 4];
    if (col.name === "host") return `worker-${i+1}.svc`;
    if (col.name === "action") return ["login","logout","update","delete"][i % 4];
    if (col.name === "actor") return ["alice@acme.io","bob@acme.io","carol@acme.io"][i % 3];
    if (col.name === "key") return `feat.${["alpha","beta","gamma","delta"][i % 4]}_${i}`;
    if (col.name === "title") return ["Ship CloudPG","Review PR #4012","Pair with Bob","Write changelog"][i % 4];
    if (col.name === "source") return ["kafka","kinesis","webhook","s3"][i % 4];
    if (col.name === "step") return ["land","signup","activate","convert"][i % 4];
    if (col.name === "owner") return ["platform","payments","growth","ml"][i % 4];
    return `value_${i+1}`;
  }
  if (t === "name") return ["postgres","app","readonly","template1"][i % 4];
  if (t === "oid") return 16384 + i * 17;
  if (t.startsWith("invoice_status")) return ["paid","open","void","draft"][i % 4];
  if (t === "bool") return i % 3 === 0;
  if (t === "int" || t === "integer" || t === "bigint" || t === "smallint" || t === "serial") {
    if (col.name.endsWith("_cents")) return (1000 + (i * 311) % 90000);
    if (col.name === "exp_month") return 1 + (i % 12);
    if (col.name === "exp_year") return 2026 + (i % 5);
    if (col.name === "quantity") return 1 + (i % 8);
    if (col.name === "rows" || col.name === "users") return Math.floor(1000 + Math.random() * 100000);
    return 1 + i;
  }
  if (t === "jsonb" || t === "json") return `{"k":"${["a","b","c","d"][i%4]}","n":${i+1}}`;
  if (t === "pg_lsn") return `0/${(0x12340000 + i * 0x1000).toString(16).toUpperCase()}`;
  if (t === "date") {
    const d = new Date(Date.now() - i * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (t === "timestamptz" || t === "timestamp") {
    const d = new Date(Date.now() - i * 86400000 * 3);
    return d.toISOString().replace("T", " ").replace("Z", "+00");
  }
  return "—";
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
    const name = dMatch[1];
    for (const [sn, s] of Object.entries(schemas)) {
      const t = (s.tables || []).find(t => t.name === name);
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
    }
    return { kind: "error", message: `Did not find any relation named "${name}".` };
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

function execSelect(sql, ctx) {
  const schemas = window.SCHEMAS[ctx.db] || {};
  const m = sql.match(/from\s+(?:(\w+)\.)?(\w+)/i);
  if (!m) return { kind: "error", message: "syntax error at or near end of statement" };
  const schemaName = m[1] || "public";
  const tableName = m[2];
  const sch = schemas[schemaName];
  const table = sch && (sch.tables || []).find(t => t.name === tableName);
  if (!table) return { kind: "error", message: `relation "${schemaName}.${tableName}" does not exist` };
  const limM = sql.match(/limit\s+(\d+)/i);
  const limit = limM ? Math.min(parseInt(limM[1], 10), 500) : Math.min(50, table.rows);
  const cols = table.cols.map(c => ({ name: c.name, type: c.type, pk: c.pk }));
  const seed = (tableName.length * 31 + ctx.db.length) >>> 0;
  const rows = Array.from({ length: limit }, (_, i) => {
    const r = {};
    for (const c of table.cols) r[c.name] = fakeRowFor(c, i, seed);
    return r;
  });
  return { kind: "table", cols, rows };
}

function execSql(sql, ctx) {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) return { kind: "noop" };
  if (trimmed.startsWith("\\")) return execMeta(trimmed, ctx);
  if (/^select/i.test(trimmed)) return execSelect(trimmed, ctx);
  if (/^explain/i.test(trimmed)) {
    return { kind: "explain", lines: [
      "                                  QUERY PLAN",
      "----------------------------------------------------------------------------",
      " Seq Scan on customers  (cost=0.00..18334.40 rows=184293 width=124)",
      "   Filter: (created_at > '2024-01-01'::timestamptz)",
      " Planning Time: 0.082 ms",
      " Execution Time: 2.412 ms",
      "(4 rows)",
    ]};
  }
  if (/^(insert|update|delete)/i.test(trimmed)) {
    const verb = trimmed.split(/\s/)[0].toUpperCase();
    return { kind: "command", message: `${verb} 1` };
  }
  if (/^(begin|commit|rollback)/i.test(trimmed)) {
    return { kind: "command", message: trimmed.toUpperCase() };
  }
  if (/^set\s/i.test(trimmed)) return { kind: "command", message: "SET" };
  if (/^show\s/i.test(trimmed)) {
    return { kind: "command", message: "—" };
  }
  return { kind: "error", message: `syntax error at or near "${trimmed.split(/\s/)[0]}"` };
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
  const [acPos, setAcPos] = sUseState({ left: 0, top: 0 });

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
      const result = execSql(sql, ctx);
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

  // Autocomplete: position popover above the textarea at the caret.
  const updateAC = (text, c) => {
    const { fragment, items, start } = getAutocompleteSuggestions(text, c, tab.db);
    if (items.length && fragment) {
      setAcState({ open: true, items, idx: 0, start });
      // Position popover
      const ta = taRef.current;
      if (!ta) return;
      const mirror = document.createElement("div");
      const cs = getComputedStyle(ta);
      for (const p of ["fontFamily","fontSize","fontWeight","lineHeight","letterSpacing","paddingTop","paddingLeft","paddingRight","paddingBottom","whiteSpace","tabSize","wordBreak","wordWrap"]) {
        mirror.style[p] = cs[p];
      }
      mirror.style.position = "absolute";
      mirror.style.visibility = "hidden";
      mirror.style.whiteSpace = "pre-wrap";
      mirror.style.width = ta.clientWidth + "px";
      mirror.style.top = "0"; mirror.style.left = "0";
      mirror.textContent = text.slice(0, start);
      const marker = document.createElement("span");
      marker.textContent = "x";
      mirror.appendChild(marker);
      document.body.appendChild(mirror);
      const mRect = marker.getBoundingClientRect();
      const taRect = ta.getBoundingClientRect();
      const wRect = wrapRef.current.getBoundingClientRect();
      document.body.removeChild(mirror);
      setAcPos({
        left: (taRect.left - wRect.left) + mRect.left,
        // Popover above input
        top: (taRect.top - wRect.top) + mRect.top - 4,
      });
    } else {
      setAcState(s => ({ ...s, open: false }));
    }
  };

  const accept = (item) => {
    const ta = taRef.current; if (!ta) return;
    const before = buffer.slice(0, acState.start);
    const after = buffer.slice(ta.selectionEnd);
    const insert = item.name + (item.kind === "fn" || item.kind === "func" ? "(" : "");
    const next = before + insert + after;
    setBuffer(next);
    const newCaret = before.length + insert.length;
    setAcState(s => ({ ...s, open: false }));
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(newCaret, newCaret);
    });
  };

  const onChange = (e) => {
    const v = e.target.value;
    setBuffer(v);
    setHIdx(-1);
    const c = e.target.selectionStart;
    updateAC(v, c);
  };

  const onKeyDown = (e) => {
    // Autocomplete navigation
    if (acState.open) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAcState(s => ({ ...s, idx: (s.idx + 1) % s.items.length })); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setAcState(s => ({ ...s, idx: (s.idx - 1 + s.items.length) % s.items.length })); return; }
      if (e.key === "Tab")       { e.preventDefault(); accept(acState.items[acState.idx]); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault(); accept(acState.items[acState.idx]); return;
      }
      if (e.key === "Escape")    { e.preventDefault(); setAcState(s => ({ ...s, open: false })); return; }
    }
    // Tab: trigger autocomplete or insert spaces
    if (e.key === "Tab") {
      e.preventDefault();
      const c = e.currentTarget.selectionStart;
      updateAC(buffer, c);
      return;
    }
    // Enter to submit (Shift+Enter = newline; meta-command starting with \ submits immediately)
    if (e.key === "Enter" && !e.shiftKey) {
      // Allow incomplete statements to continue on newline naturally
      if (isCompleteStatement(buffer)) {
        e.preventDefault();
        run(buffer);
      }
      // else: let Enter insert a newline (textarea default)
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
      const next = Math.min(hist.length - 1, hIdx + 1);
      setHIdx(next);
      setBuffer(hist[next]);
      queueMicrotask(() => taRef.current?.setSelectionRange(0, 0));
      return;
    }
    if (e.key === "ArrowDown" && atEnd) {
      const hist = tab.history || [];
      if (hIdx === -1) return;
      e.preventDefault();
      const next = hIdx - 1;
      setHIdx(next);
      if (next === -1) setBuffer(hStash);
      else setBuffer(hist[next]);
      return;
    }
    // Cmd+L clear screen
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      onUpdateTab({ log: [{ kind: "notice", text: "(cleared)" }] });
      return;
    }
  };

  // Focus textarea when clicking inside the log area (real psql-y feel)
  const onSessionMouseDown = (e) => {
    // Don't steal focus if user is selecting text
    const sel = window.getSelection();
    if (sel && sel.toString()) return;
    setTimeout(() => taRef.current?.focus(), 0);
  };

  return (
    <div className="repl" ref={wrapRef} onMouseDown={onSessionMouseDown}>
      <div className="repl-log" ref={logRef}>
        {(tab.log || []).map((e, i) => {
          if (e.kind === "welcome") return <div key={i} className="psql-line dim">{e.text}</div>;
          if (e.kind === "notice")  return <div key={i} className="psql-line notice">{e.text}</div>;
          if (e.kind === "ok")      return <div key={i} className="psql-line ok">{e.text}</div>;
          if (e.kind === "info")    return <div key={i} className="psql-line">{e.text}</div>;
          if (e.kind === "timing")  return <div key={i} className="psql-line dim">Time: {e.ms} ms</div>;
          if (e.kind === "prompt") {
            // Multiline command shown with continuation prompts
            const lines = e.text.split("\n");
            return (
              <div key={i} className="psql-line cmd-echo">
                {lines.map((ln, j) => (
                  <div key={j}>
                    <span className="prompt-prefix">
                      {j === 0
                        ? `${e.db}=>`
                        : `${e.db}->`}
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
      </div>

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
        </div>
      </div>

      {acState.open && (
        <div
          className="ac-pop"
          style={{
            left: acPos.left,
            // Anchor popover ABOVE the caret line; transform up by its own height
            top: acPos.top,
            transform: "translateY(-100%)",
          }}
        >
          {acState.items.map((it, i) => (
            <div
              key={it.kind + it.name}
              className={`ac-item${i === acState.idx ? " is-active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); accept(it); }}
              onMouseEnter={() => setAcState(s => ({ ...s, idx: i }))}
            >
              <span className="kind">{it.kind}</span>
              <span className="name">{it.name}</span>
              {it.hint && <span className="hint">{it.hint}</span>}
            </div>
          ))}
          <div style={{ display: "flex", gap: 12, padding: "6px 8px 2px", borderTop: "1px solid var(--line)", marginTop: 4, fontSize: 10, color: "var(--fg-mute)", fontFamily: "JetBrains Mono, monospace" }}>
            <span><kbd style={{ background: "var(--bg-active)", border: "1px solid var(--line)", padding: "0 4px", borderRadius: 3 }}>↑↓</kbd> nav</span>
            <span><kbd style={{ background: "var(--bg-active)", border: "1px solid var(--line)", padding: "0 4px", borderRadius: 3 }}>Tab</kbd> accept</span>
            <span><kbd style={{ background: "var(--bg-active)", border: "1px solid var(--line)", padding: "0 4px", borderRadius: 3 }}>Esc</kbd> close</span>
          </div>
        </div>
      )}
    </div>
  );
}

window.Session = Session;
