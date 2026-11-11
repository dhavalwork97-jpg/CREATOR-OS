// Foundation schema: accounts, durable task queue, agent runs, append-only audit, agent settings.
// Additive only: nothing here touches creator_os_state. `down` drops only what `up` created.
export const id = "0001_foundation";

export const up = [

  `CREATE TABLE IF NOT EXISTS ig_accounts (
    account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_email text NOT NULL,
    ig_user_id text NOT NULL UNIQUE,
    username text,
    connection_status text NOT NULL DEFAULT 'unknown'
      CHECK (connection_status IN ('unknown','connected','error','disconnected')),
    token_status text NOT NULL DEFAULT 'unknown'
      CHECK (token_status IN ('unknown','valid','expiring','invalid')),
    token_checked_at timestamptz,
    token_expires_at timestamptz,
    last_error text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES ig_accounts(account_id),
    agent text NOT NULL,
    task_type text NOT NULL,
    input jsonb NOT NULL DEFAULT '{}'::jsonb,
    output jsonb,
    status text NOT NULL DEFAULT 'queued'
      CHECK (status IN ('pending','queued','running','waiting_approval','completed','failed','cancelled','retrying')),
    priority integer NOT NULL DEFAULT 0,
    idempotency_key text NOT NULL UNIQUE,
    parent_task_id uuid REFERENCES agent_tasks(task_id),
    external_effect boolean NOT NULL DEFAULT false,
    retry_safe boolean NOT NULL DEFAULT true,
    retry_count integer NOT NULL DEFAULT 0,
    max_retries integer NOT NULL DEFAULT 3,
    timeout_seconds integer NOT NULL DEFAULT 120,
    run_after timestamptz NOT NULL DEFAULT now(),
    timeout_at timestamptz,
    locked_by text,
    locked_at timestamptz,
    error jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS agent_tasks_claim_idx ON agent_tasks (status, run_after, priority DESC)`,
  `CREATE INDEX IF NOT EXISTS agent_tasks_account_idx ON agent_tasks (account_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS agent_tasks_parent_idx ON agent_tasks (parent_task_id)`,

  `CREATE TABLE IF NOT EXISTS agent_task_deps (
    task_id uuid NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
    depends_on uuid NOT NULL REFERENCES agent_tasks(task_id),
    PRIMARY KEY (task_id, depends_on),
    CHECK (task_id <> depends_on)
  )`,

  `CREATE TABLE IF NOT EXISTS agent_runs (
    run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES agent_tasks(task_id),
    account_id uuid NOT NULL REFERENCES ig_accounts(account_id),
    agent text NOT NULL,
    attempt integer NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('completed','failed','retry','timeout','cancelled')),
    decision jsonb NOT NULL DEFAULT '{}'::jsonb,
    error jsonb,
    started_at timestamptz NOT NULL,
    finished_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs (task_id, started_at)`,

  `CREATE TABLE IF NOT EXISTS audit_events (
    event_id bigserial PRIMARY KEY,
    account_id uuid REFERENCES ig_accounts(account_id),
    actor text NOT NULL,
    action text NOT NULL,
    subject_type text,
    subject_id text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS audit_events_account_idx ON audit_events (account_id, created_at DESC)`,

  // Autonomy defaults to copilot; agents have no code path that writes this table.
  `CREATE TABLE IF NOT EXISTS agent_settings (
    account_id uuid PRIMARY KEY REFERENCES ig_accounts(account_id),
    autonomy_mode text NOT NULL DEFAULT 'copilot'
      CHECK (autonomy_mode IN ('copilot','supervised','bounded')),
    monitoring jsonb NOT NULL DEFAULT '{}'::jsonb,
    limits jsonb NOT NULL DEFAULT '{}'::jsonb,
    notifications jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`
];

export const down = [
  `DROP TABLE IF EXISTS agent_settings`,
  `DROP TABLE IF EXISTS audit_events`,
  `DROP TABLE IF EXISTS agent_runs`,
  `DROP TABLE IF EXISTS agent_task_deps`,
  `DROP TABLE IF EXISTS agent_tasks`,
  `DROP TABLE IF EXISTS ig_accounts`
];
