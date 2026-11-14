// Phase 5: append-only safety reviews and owner-controlled safety settings.
// Reviews are immutable (no UPDATE path exists in code). Agents INSERT reviews; only the owner route writes settings.
export const id = "0006_safety";

export const up = [
  `ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS safety jsonb NOT NULL DEFAULT '{}'::jsonb`,
  `CREATE TABLE IF NOT EXISTS safety_reviews (
    review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES ig_accounts(account_id),
    subject_type text NOT NULL CHECK (subject_type IN ('board_card')),
    subject_id text NOT NULL,
    content_hash text NOT NULL,
    status text NOT NULL CHECK (status IN ('approved','needs_revision','human_review','blocked')),
    findings jsonb NOT NULL DEFAULT '[]'::jsonb,
    rules_version text NOT NULL,
    reviewer text NOT NULL DEFAULT 'deterministic_rules',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS safety_reviews_subject_idx ON safety_reviews (account_id, subject_type, subject_id, created_at DESC)`
];

export const down = [
  `DROP TABLE IF EXISTS safety_reviews`,
  `ALTER TABLE agent_settings DROP COLUMN IF EXISTS safety`
];
