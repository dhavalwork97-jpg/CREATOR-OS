// Phase 1: Instagram monitor history. Rows are insert-only: a failed or partial API call can never
// overwrite earlier history. Unavailable metrics are stored as null/absent plus a recorded reason.
export const id = "0002_monitor";

export const up = [
  `CREATE TABLE IF NOT EXISTS account_snapshots (
    snapshot_id bigserial PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES ig_accounts(account_id),
    kind text NOT NULL CHECK (kind IN ('profile','insights')),
    collected_at timestamptz NOT NULL DEFAULT now(),
    window_start timestamptz,
    window_end timestamptz,
    followers integer,
    following integer,
    media_count integer,
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    unavailable jsonb NOT NULL DEFAULT '{}'::jsonb,
    source text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS account_snapshots_idx ON account_snapshots (account_id, kind, collected_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_insights_window_uq ON account_snapshots (account_id, window_end) WHERE kind = 'insights'`,

  `CREATE TABLE IF NOT EXISTS media_items (
    media_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES ig_accounts(account_id),
    ig_media_id text NOT NULL,
    caption text,
    media_type text,
    product_type text,
    permalink text,
    posted_at timestamptz,
    like_count integer,
    comments_count integer,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, ig_media_id)
  )`,
  `CREATE INDEX IF NOT EXISTS media_items_posted_idx ON media_items (account_id, posted_at DESC)`,

  `CREATE TABLE IF NOT EXISTS media_insights (
    insight_id bigserial PRIMARY KEY,
    media_id uuid NOT NULL REFERENCES media_items(media_id),
    checkpoint text NOT NULL CHECK (checkpoint IN ('h1','h24','h72','d7','baseline')),
    collected_at timestamptz NOT NULL DEFAULT now(),
    age_hours numeric(10,2),
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    unavailable jsonb NOT NULL DEFAULT '{}'::jsonb,
    source text NOT NULL,
    UNIQUE (media_id, checkpoint)
  )`
];

export const down = [
  `DROP TABLE IF EXISTS media_insights`,
  `DROP TABLE IF EXISTS media_items`,
  `DROP TABLE IF EXISTS account_snapshots`
];
