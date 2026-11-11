// Phase 2: derived performance observations. Derived only from stored Meta metrics; never read by anything that
// changes permissions. One row per (account, kind, group, calendar day); a same-day recompute refreshes the row.
export const id = "0003_analytics";

export const up = [
  `CREATE TABLE IF NOT EXISTS performance_insights (
    insight_id bigserial PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES ig_accounts(account_id),
    kind text NOT NULL,
    group_key text NOT NULL DEFAULT '',
    computed_on date NOT NULL,
    status text NOT NULL CHECK (status IN ('recommendation','observation','insufficient_data')),
    observation text NOT NULL,
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    sample_size integer NOT NULL DEFAULT 0,
    confidence text NOT NULL CHECK (confidence IN ('none','low','medium','high')),
    suggested_action text,
    window_label text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, kind, group_key, computed_on)
  )`,
  `CREATE INDEX IF NOT EXISTS performance_insights_latest_idx ON performance_insights (account_id, computed_on DESC)`
];

export const down = [`DROP TABLE IF EXISTS performance_insights`];
