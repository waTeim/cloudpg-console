/* ============================================================
   Mock kubernetes contexts + CNPG inventory + schemas.
   Sources (~/.kube/config vs $KUBECONFIG/*) are flattened away
   on the way in — the UI shows the resulting set of contexts.
   ============================================================ */

window.CONTEXTS = {
  "prod-us-east-1": {
    cluster: "arn:aws:eks:us-east-1:5567:cluster/prod-us-east-1",
    user: "alice@acme.io",
    server: "https://A5C8.gr7.us-east-1.eks.amazonaws.com",
    region: "us-east-1",
    namespaces: [
      {
        name: "platform",
        clusters: [
          {
            name: "billing-db",
            phase: "Healthy",
            ready: 3, instances: 3,
            pgVersion: "16.2",
            primary: "billing-db-1",
            databases: ["billing", "billing_audit", "postgres", "template1"],
            users: [
              { name: "app",       role: "app",        secret: "cnpg-billing-db-user-app",       databases: ["billing"] },
              { name: "readonly",  role: "readonly",   secret: "cnpg-billing-db-user-readonly",  databases: ["billing", "billing_audit"] },
              { name: "migrator",  role: "migrator",   secret: "cnpg-billing-db-user-migrator",  databases: ["billing", "billing_audit"] },
              { name: "auditor",   role: "readonly",   secret: "cnpg-billing-db-user-auditor",   databases: ["billing_audit"] },
              { name: "postgres",  role: "superuser",  secret: "cnpg-billing-db-user-postgres",  databases: ["billing", "billing_audit", "postgres", "template1"] },
            ],
          },
          {
            name: "identity-db",
            phase: "Healthy",
            ready: 3, instances: 3,
            pgVersion: "16.2",
            primary: "identity-db-2",
            databases: ["identity", "postgres", "template1"],
            users: [
              { name: "app",       role: "app",        secret: "cnpg-identity-db-user-app",      databases: ["identity"] },
              { name: "readonly",  role: "readonly",   secret: "cnpg-identity-db-user-readonly", databases: ["identity"] },
              { name: "postgres",  role: "superuser",  secret: "cnpg-identity-db-user-postgres", databases: ["identity", "postgres", "template1"] },
            ],
          },
        ],
      },
      {
        name: "analytics",
        clusters: [
          {
            name: "events-warehouse",
            phase: "Healthy",
            ready: 5, instances: 5,
            pgVersion: "16.2",
            primary: "events-warehouse-1",
            databases: ["events", "events_staging", "events_marts", "postgres", "template1"],
            users: [
              { name: "app",       role: "app",        secret: "cnpg-events-warehouse-user-app",     databases: ["events"] },
              { name: "etl",       role: "etl",        secret: "cnpg-events-warehouse-user-etl",     databases: ["events", "events_staging"] },
              { name: "analyst",   role: "readonly",   secret: "cnpg-events-warehouse-user-analyst", databases: ["events", "events_marts"] },
              { name: "postgres",  role: "superuser",  secret: "cnpg-events-warehouse-user-postgres", databases: ["events", "events_staging", "events_marts", "postgres", "template1"] },
            ],
          },
        ],
      },
      {
        name: "default",
        clusters: [],
      },
    ],
  },
  "prod-eu-west-1": {
    cluster: "arn:aws:eks:eu-west-1:5567:cluster/prod-eu-west-1",
    user: "alice@acme.io",
    server: "https://4F2A.gr7.eu-west-1.eks.amazonaws.com",
    region: "eu-west-1",
    namespaces: [
      {
        name: "platform",
        clusters: [
          {
            name: "billing-db",
            phase: "Failing over",
            ready: 2, instances: 3,
            pgVersion: "16.1",
            primary: "billing-db-3",
            databases: ["billing", "postgres", "template1"],
            users: [
              { name: "app",       role: "app",        secret: "cnpg-billing-db-user-app",      databases: ["billing"] },
              { name: "readonly",  role: "readonly",   secret: "cnpg-billing-db-user-readonly", databases: ["billing"] },
              { name: "postgres",  role: "superuser",  secret: "cnpg-billing-db-user-postgres", databases: ["billing", "postgres", "template1"] },
            ],
          },
        ],
      },
    ],
  },
  "team-alpha-eks": {
    cluster: "arn:aws:eks:us-west-2:7791:cluster/team-alpha",
    user: "alice@acme.io",
    server: "https://9B3E.gr7.us-west-2.eks.amazonaws.com",
    region: "us-west-2",
    namespaces: [
      {
        name: "alpha-svc",
        clusters: [
          {
            name: "feature-store",
            phase: "Healthy",
            ready: 3, instances: 3,
            pgVersion: "16.2",
            primary: "feature-store-1",
            databases: ["features", "postgres", "template1"],
            users: [
              { name: "app",       role: "app",        secret: "cnpg-feature-store-user-app",      databases: ["features"] },
              { name: "readonly",  role: "readonly",   secret: "cnpg-feature-store-user-readonly", databases: ["features"] },
              { name: "postgres",  role: "superuser",  secret: "cnpg-feature-store-user-postgres", databases: ["features", "postgres", "template1"] },
            ],
          },
          {
            name: "queue-db",
            phase: "Upgrading",
            ready: 2, instances: 3,
            pgVersion: "15.6 → 16.2",
            primary: "queue-db-1",
            databases: ["queue", "postgres", "template1"],
            users: [
              { name: "app",       role: "app",        secret: "cnpg-queue-db-user-app",      databases: ["queue"] },
              { name: "postgres",  role: "superuser",  secret: "cnpg-queue-db-user-postgres", databases: ["queue", "postgres", "template1"] },
            ],
          },
        ],
      },
    ],
  },
  "team-alpha-eks-canary": {
    cluster: "arn:aws:eks:us-west-2:7791:cluster/team-alpha-canary",
    user: "alice@acme.io",
    server: "https://9B3E-canary.gr7.us-west-2.eks.amazonaws.com",
    region: "us-west-2",
    namespaces: [
      {
        name: "alpha-svc",
        clusters: [
          {
            name: "feature-store",
            phase: "Healthy",
            ready: 1, instances: 1,
            pgVersion: "16.2",
            primary: "feature-store-1",
            databases: ["features", "postgres", "template1"],
            users: [
              { name: "app",       role: "app",        secret: "cnpg-feature-store-user-app",      databases: ["features"] },
              { name: "postgres",  role: "superuser",  secret: "cnpg-feature-store-user-postgres", databases: ["features", "postgres", "template1"] },
            ],
          },
        ],
      },
    ],
  },
  "staging-gke": {
    cluster: "gke_acme-staging_us-central1_staging",
    user: "alice@acme.io",
    server: "https://34.122.99.18",
    region: "us-central1",
    namespaces: [
      {
        name: "default",
        clusters: [
          {
            name: "scratch",
            phase: "Healthy",
            ready: 1, instances: 1,
            pgVersion: "16.2",
            primary: "scratch-1",
            databases: ["scratch", "postgres", "template1"],
            users: [
              { name: "app",       role: "app",        secret: "cnpg-scratch-user-app",      databases: ["scratch"] },
              { name: "postgres",  role: "superuser",  secret: "cnpg-scratch-user-postgres", databases: ["scratch", "postgres", "template1"] },
            ],
          },
        ],
      },
    ],
  },
  "dev-minikube": {
    cluster: "minikube",
    user: "minikube",
    server: "https://127.0.0.1:53254",
    region: "local",
    namespaces: [
      {
        name: "default",
        clusters: [
          {
            name: "local-dev",
            phase: "Healthy",
            ready: 1, instances: 1,
            pgVersion: "16.2",
            primary: "local-dev-1",
            databases: ["appdb", "postgres", "template1"],
            users: [
              { name: "app",       role: "app",        secret: "cnpg-local-dev-user-app",      databases: ["appdb"] },
              { name: "postgres",  role: "superuser",  secret: "cnpg-local-dev-user-postgres", databases: ["appdb", "postgres", "template1"] },
            ],
          },
        ],
      },
    ],
  },
};

// Phase → badge variant
window.PHASE_VARIANT = {
  "Healthy":      "ok",
  "Upgrading":    "warn",
  "Failing over": "err",
  "Degraded":     "warn",
};

// =========================================================
// Per-cluster schemas (used by schema browser + autocomplete
// + meta-commands + query "execution")
// =========================================================
window.SCHEMAS = {
  "billing": {
    public: {
      tables: [
        {
          name: "customers", rows: 184_293,
          cols: [
            { name: "id",            type: "uuid",       pk: true },
            { name: "email",         type: "citext" },
            { name: "display_name",  type: "text" },
            { name: "country",       type: "char(2)" },
            { name: "created_at",    type: "timestamptz" },
            { name: "updated_at",    type: "timestamptz" },
            { name: "deleted_at",    type: "timestamptz" },
          ],
        },
        {
          name: "invoices", rows: 2_104_882,
          cols: [
            { name: "id",            type: "bigint",     pk: true },
            { name: "customer_id",   type: "uuid" },
            { name: "issued_at",     type: "timestamptz" },
            { name: "due_at",        type: "timestamptz" },
            { name: "status",        type: "invoice_status" },
            { name: "total_cents",   type: "bigint" },
            { name: "currency",      type: "char(3)" },
          ],
        },
        {
          name: "line_items", rows: 8_812_044,
          cols: [
            { name: "id",            type: "bigint",     pk: true },
            { name: "invoice_id",    type: "bigint" },
            { name: "sku",           type: "text" },
            { name: "quantity",      type: "int" },
            { name: "unit_cents",    type: "bigint" },
          ],
        },
        {
          name: "subscriptions", rows: 92_104,
          cols: [
            { name: "id",            type: "bigint",     pk: true },
            { name: "customer_id",   type: "uuid" },
            { name: "plan",          type: "text" },
            { name: "status",        type: "text" },
            { name: "started_at",    type: "timestamptz" },
            { name: "renewed_at",    type: "timestamptz" },
            { name: "cancelled_at",  type: "timestamptz" },
          ],
        },
        {
          name: "payment_methods", rows: 119_402,
          cols: [
            { name: "id",            type: "uuid",       pk: true },
            { name: "customer_id",   type: "uuid" },
            { name: "brand",         type: "text" },
            { name: "last4",         type: "char(4)" },
            { name: "exp_month",     type: "int" },
            { name: "exp_year",      type: "int" },
          ],
        },
      ],
      views: ["overdue_invoices", "mrr_by_plan"],
      functions: ["compute_tax(invoice_id bigint)", "next_invoice_no()"],
    },
    cnpg: {
      tables: [
        { name: "backups", rows: 412, cols: [
          { name: "id", type: "uuid", pk: true },
          { name: "started_at", type: "timestamptz" },
          { name: "lsn", type: "pg_lsn" },
        ]},
      ],
      views: [], functions: [],
    },
  },
  "identity": {
    public: {
      tables: [
        { name: "users", rows: 412_882, cols: [
          { name: "id", type: "uuid", pk: true },
          { name: "email", type: "citext" },
          { name: "verified_at", type: "timestamptz" },
        ]},
        { name: "sessions", rows: 9_004_812, cols: [
          { name: "id", type: "uuid", pk: true },
          { name: "user_id", type: "uuid" },
          { name: "issued_at", type: "timestamptz" },
          { name: "expires_at", type: "timestamptz" },
        ]},
        { name: "audit_log", rows: 88_104_044, cols: [
          { name: "id", type: "bigint", pk: true },
          { name: "actor_id", type: "uuid" },
          { name: "action", type: "text" },
          { name: "at", type: "timestamptz" },
        ]},
      ],
      views: [], functions: [],
    },
  },
  "events": {
    public: {
      tables: [
        { name: "events", rows: 4_812_044_192, cols: [
          { name: "ts", type: "timestamptz" },
          { name: "event_id", type: "uuid", pk: true },
          { name: "user_id", type: "uuid" },
          { name: "name", type: "text" },
          { name: "props", type: "jsonb" },
        ]},
        { name: "sessions", rows: 882_044_002, cols: [
          { name: "id", type: "uuid", pk: true },
          { name: "user_id", type: "uuid" },
          { name: "started_at", type: "timestamptz" },
          { name: "ended_at", type: "timestamptz" },
        ]},
      ],
      views: ["daily_active_users"], functions: [],
    },
  },
  "features": {
    public: {
      tables: [
        { name: "features", rows: 4_201, cols: [
          { name: "key", type: "text", pk: true },
          { name: "name", type: "text" },
          { name: "owner", type: "text" },
        ]},
        { name: "feature_values", rows: 88_204_002, cols: [
          { name: "entity_id", type: "uuid" },
          { name: "feature_key", type: "text" },
          { name: "value", type: "jsonb" },
          { name: "computed_at", type: "timestamptz" },
        ]},
      ],
      views: [], functions: [],
    },
  },
  "queue": {
    public: {
      tables: [
        { name: "jobs", rows: 412_882, cols: [
          { name: "id", type: "bigint", pk: true },
          { name: "queue", type: "text" },
          { name: "payload", type: "jsonb" },
          { name: "scheduled_at", type: "timestamptz" },
        ]},
        { name: "workers", rows: 18, cols: [
          { name: "id", type: "uuid", pk: true },
          { name: "host", type: "text" },
          { name: "last_seen_at", type: "timestamptz" },
        ]},
      ],
      views: [], functions: [],
    },
  },
  "scratch": {
    public: {
      tables: [
        { name: "scratch", rows: 12, cols: [
          { name: "id", type: "int", pk: true },
          { name: "note", type: "text" },
          { name: "at", type: "timestamptz" },
        ]},
      ],
      views: [], functions: [],
    },
  },
  "appdb": {
    public: {
      tables: [
        { name: "todos", rows: 42, cols: [
          { name: "id", type: "serial", pk: true },
          { name: "title", type: "text" },
          { name: "done", type: "bool" },
          { name: "created_at", type: "timestamptz" },
        ]},
      ],
      views: [], functions: [],
    },
  },
  "billing_audit": {
    public: {
      tables: [
        { name: "events", rows: 14_882_104, cols: [
          { name: "id",          type: "bigint", pk: true },
          { name: "actor",       type: "text" },
          { name: "action",      type: "text" },
          { name: "subject_id",  type: "uuid" },
          { name: "at",          type: "timestamptz" },
        ]},
        { name: "change_sets", rows: 412_209, cols: [
          { name: "id",       type: "uuid",   pk: true },
          { name: "title",    type: "text" },
          { name: "deployed", type: "bool" },
          { name: "at",       type: "timestamptz" },
        ]},
      ],
      views: [], functions: [],
    },
  },
  "events_staging": {
    public: {
      tables: [
        { name: "raw_events", rows: 8_812_044_192, cols: [
          { name: "id",      type: "uuid", pk: true },
          { name: "payload", type: "jsonb" },
          { name: "at",      type: "timestamptz" },
        ]},
        { name: "ingest_runs", rows: 18_402, cols: [
          { name: "id",       type: "bigint", pk: true },
          { name: "source",   type: "text" },
          { name: "rows",     type: "bigint" },
          { name: "at",       type: "timestamptz" },
        ]},
      ],
      views: [], functions: [],
    },
  },
  "events_marts": {
    public: {
      tables: [
        { name: "dau",        rows: 1_842, cols: [
          { name: "day",      type: "date",   pk: true },
          { name: "users",    type: "bigint" },
        ]},
        { name: "funnel_steps", rows: 42_004, cols: [
          { name: "day",      type: "date" },
          { name: "step",     type: "text" },
          { name: "users",    type: "bigint" },
        ]},
      ],
      views: ["weekly_retention"], functions: [],
    },
  },
  "postgres": {
    pg_catalog: {
      tables: [
        { name: "pg_database",  rows: 5, cols: [
          { name: "oid",      type: "oid", pk: true },
          { name: "datname",  type: "name" },
          { name: "datdba",   type: "oid" },
        ]},
        { name: "pg_roles",     rows: 18, cols: [
          { name: "oid",      type: "oid", pk: true },
          { name: "rolname",  type: "name" },
          { name: "rolsuper", type: "bool" },
        ]},
      ],
      views: [], functions: [],
    },
  },
  "template1": {
    pg_catalog: { tables: [], views: [], functions: [] },
  },
};

// SQL keywords for autocomplete + highlighter
window.SQL_KEYWORDS = [
  "select","from","where","group","by","order","limit","offset","having",
  "join","left","right","inner","outer","on","as","with","insert","into",
  "values","update","set","delete","returning","union","all","distinct",
  "create","table","index","view","drop","alter","add","column","constraint",
  "primary","key","foreign","references","not","null","default","unique",
  "begin","commit","rollback","savepoint","explain","analyze","verbose",
  "case","when","then","else","end","and","or","in","is","like","ilike",
  "between","exists","array","using","cross","lateral","window","over",
  "partition","rows","range","preceding","following","current","row"
];

window.SQL_FUNCTIONS = [
  "count","sum","avg","min","max","coalesce","nullif","greatest","least",
  "now","current_timestamp","current_date","date_trunc","extract","age",
  "to_char","to_timestamp","upper","lower","length","substring","trim",
  "concat","jsonb_build_object","jsonb_path_query","row_number","rank",
  "dense_rank","lag","lead","generate_series","array_agg","string_agg",
];

window.PSQL_META = [
  { cmd: "\\dt",   desc: "list tables" },
  { cmd: "\\dt+",  desc: "list tables (verbose, sizes)" },
  { cmd: "\\d",    desc: "describe relation" },
  { cmd: "\\d+",   desc: "describe relation (verbose)" },
  { cmd: "\\dv",   desc: "list views" },
  { cmd: "\\df",   desc: "list functions" },
  { cmd: "\\dn",   desc: "list schemas" },
  { cmd: "\\du",   desc: "list roles" },
  { cmd: "\\l",    desc: "list databases" },
  { cmd: "\\c",    desc: "connect to database" },
  { cmd: "\\timing", desc: "toggle timing" },
  { cmd: "\\x",    desc: "toggle expanded display" },
  { cmd: "\\q",    desc: "close tab" },
  { cmd: "\\?",    desc: "help" },
];
