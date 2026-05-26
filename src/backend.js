/* ============================================================
   Async data layer — replaces src/data.js mock.
   Fetches k8s / CNPG inventory via window.cloudpg IPC and
   exposes window.backend.bootstrap() / window.backend.introspect().
   Also defines the global constants that the JSX files reference.
   ============================================================ */

// ---------- constants (previously in data.js) ----------

window.SCHEMAS = {};

window.PHASE_VARIANT = {
  "Healthy":                  "ok",
  "Cluster in healthy state": "ok",
  "Upgrading":                "warn",
  "Failing over":             "err",
  "Degraded":                 "warn",
};

window.SQL_KEYWORDS = [
  "select","from","where","group","by","order","limit","offset","having",
  "join","left","right","inner","outer","on","as","with","insert","into",
  "values","update","set","delete","returning","union","all","distinct",
  "create","table","index","view","drop","alter","add","column","constraint",
  "primary","key","foreign","references","not","null","default","unique",
  "begin","commit","rollback","savepoint","explain","analyze","verbose",
  "case","when","then","else","end","and","or","in","is","like","ilike",
  "between","exists","array","using","cross","lateral","window","over",
  "partition","rows","range","preceding","following","current","row",
];

window.SQL_FUNCTIONS = [
  "count","sum","avg","min","max","coalesce","nullif","greatest","least",
  "now","current_timestamp","current_date","date_trunc","extract","age",
  "to_char","to_timestamp","upper","lower","length","substring","trim",
  "concat","jsonb_build_object","jsonb_path_query","row_number","rank",
  "dense_rank","lag","lead","generate_series","array_agg","string_agg",
];

window.PSQL_META = [
  { cmd: "\\dt",     desc: "list tables" },
  { cmd: "\\dt+",    desc: "list tables (verbose, sizes)" },
  { cmd: "\\d",      desc: "describe relation" },
  { cmd: "\\d+",     desc: "describe relation (verbose)" },
  { cmd: "\\dv",     desc: "list views" },
  { cmd: "\\df",     desc: "list functions" },
  { cmd: "\\dn",     desc: "list schemas" },
  { cmd: "\\du",     desc: "list roles" },
  { cmd: "\\l",      desc: "list databases" },
  { cmd: "\\c",      desc: "connect to database" },
  { cmd: "\\timing", desc: "toggle timing" },
  { cmd: "\\x",      desc: "toggle expanded display" },
  { cmd: "\\q",      desc: "close tab" },
  { cmd: "\\?",      desc: "help" },
];

// ---------- backend object ----------

window.backend = {
  // Load the full k8s/CNPG tree, grouped by *k8s cluster* (not kube context),
  // so multiple contexts sharing the same cluster are unioned. Each level
  // carries `contextNames` listing which kube contexts can reach it — used
  // both to pick a working context at connect time and for UI disambiguation.
  async bootstrap() {
    const ctxList = await window.cloudpg.k8s.listContexts();

    // Group kube contexts by the k8s cluster they point at.
    const byCluster = {};
    for (const ctx of ctxList) {
      const k = ctx.cluster || ctx.name;
      (byCluster[k] ||= []).push(ctx);
    }

    const clusters = {};

    await Promise.allSettled(Object.entries(byCluster).map(async ([clusterName, ctxs]) => {
      // Union of namespaces reachable from any context on this cluster.
      const nsMap = new Map();  // nsName -> Set<contextName>
      await Promise.allSettled(ctxs.map(async (ctx) => {
        try {
          const nsNames = await window.cloudpg.k8s.listNamespaces(ctx.name);
          for (const n of nsNames) {
            if (!nsMap.has(n)) nsMap.set(n, new Set());
            nsMap.get(n).add(ctx.name);
          }
        } catch (_) {}
      }));

      const namespaces = [];
      await Promise.all([...nsMap.entries()].map(async ([nsName, ctxSet]) => {
        // Union of CNPG clusters in this namespace across all qualifying contexts.
        const cnpgMap = new Map();  // cnpgName -> { ...cnpg, userMap, contextNames }

        await Promise.allSettled([...ctxSet].map(async (ctxName) => {
          let cnpgClusters = [];
          try {
            cnpgClusters = await window.cloudpg.k8s.listCNPGClusters(ctxName, nsName);
          } catch (_) { return; }

          await Promise.allSettled(cnpgClusters.map(async (cl) => {
            if (!cnpgMap.has(cl.name)) {
              cnpgMap.set(cl.name, { ...cl, userMap: new Map(), contextNames: new Set() });
            }
            cnpgMap.get(cl.name).contextNames.add(ctxName);
            try {
              const users = await window.cloudpg.k8s.listCNPGUsers(ctxName, nsName, cl.name);
              const slot  = cnpgMap.get(cl.name);
              for (const u of users) {
                if (!slot.userMap.has(u.name)) {
                  slot.userMap.set(u.name, { ...u, contextNames: new Set() });
                }
                slot.userMap.get(u.name).contextNames.add(ctxName);
              }
            } catch (_) {}
          }));
        }));

        namespaces.push({
          name:         nsName,
          contextNames: [...ctxSet],
          clusters:     [...cnpgMap.values()].map(({ userMap, contextNames, ...rest }) => ({
            ...rest,
            contextNames: [...contextNames],
            users:        [...userMap.values()].map(u => ({
              ...u,
              contextNames: [...u.contextNames],
            })),
          })),
        });
      }));

      namespaces.sort((a, b) => a.name.localeCompare(b.name));

      clusters[clusterName] = {
        name:         clusterName,
        contextNames: ctxs.map(c => c.name),
        namespaces,
      };
    }));

    return clusters;
  },

  // After a session is connected, introspect the database schema and
  // populate window.SCHEMAS[db] for the meta-command handler.
  async introspect(sessionId, db) {
    const tableSql = `
      SELECT
        n.nspname            AS schema_name,
        c.relname            AS table_name,
        c.reltuples::bigint  AS est_rows,
        a.attname            AS col_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS col_type,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_index i
          WHERE i.indisprimary
            AND i.indrelid = c.oid
            AND a.attnum = ANY(i.indkey)
        ) AS is_pk
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r','p')
        AND n.nspname NOT IN ('pg_toast','information_schema')
      ORDER BY n.nspname, c.relname, a.attnum;
    `;
    const viewSql = `
      SELECT n.nspname AS schema_name, c.relname AS view_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'v'
        AND n.nspname NOT IN ('pg_toast','information_schema')
      ORDER BY n.nspname, c.relname;
    `;
    const fnSql = `
      SELECT n.nspname AS schema_name,
             p.proname || '('
               || pg_catalog.pg_get_function_arguments(p.oid)
               || ')' AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_toast','information_schema','pg_catalog','pg_internal')
      ORDER BY n.nspname, p.proname;
    `;

    try {
      const [tableRes, viewRes, fnRes] = await Promise.all([
        window.cloudpg.pg.query(sessionId, tableSql),
        window.cloudpg.pg.query(sessionId, viewSql),
        window.cloudpg.pg.query(sessionId, fnSql),
      ]);

      const schema = {};

      if (tableRes.rows) {
        for (const row of tableRes.rows) {
          if (!schema[row.schema_name]) {
            schema[row.schema_name] = { tables: [], views: [], functions: [] };
          }
          let tbl = schema[row.schema_name].tables.find(t => t.name === row.table_name);
          if (!tbl) {
            tbl = { name: row.table_name, rows: Number(row.est_rows) || 0, cols: [] };
            schema[row.schema_name].tables.push(tbl);
          }
          if (row.col_name) {
            tbl.cols.push({ name: row.col_name, type: row.col_type, pk: row.is_pk });
          }
        }
      }

      if (viewRes.rows) {
        for (const row of viewRes.rows) {
          if (!schema[row.schema_name]) {
            schema[row.schema_name] = { tables: [], views: [], functions: [] };
          }
          schema[row.schema_name].views.push(row.view_name);
        }
      }

      if (fnRes.rows) {
        for (const row of fnRes.rows) {
          if (!schema[row.schema_name]) {
            schema[row.schema_name] = { tables: [], views: [], functions: [] };
          }
          schema[row.schema_name].functions.push(row.signature);
        }
      }

      window.SCHEMAS[db] = schema;
    } catch (e) {
      console.warn('Schema introspection failed for', db, e);
    }
  },
};
