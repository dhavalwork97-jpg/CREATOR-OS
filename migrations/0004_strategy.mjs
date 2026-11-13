// Phase 3: opportunities (Researcher output), content plan items (Strategist output) and strategy settings.
// Additive; `down` drops only what `up` created. Nothing here can publish: plan items become Content Board
// cards that still need media, safety review and owner approval.
export const id = "0004_strategy";

export const up = [
  `ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS strategy jsonb NOT NULL DEFAULT '{}'::jsonb`,

  `CREATE TABLE IF NOT EXISTS content_opportunities (
    opportunity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES ig_accounts(account_id),
    dedupe_key text NOT NULL,
    source_class text NOT NULL CHECK (source_class IN ('account_analytics','external_research','ai_hypothesis','verified_fact')),
    title text NOT NULL,
    summary text NOT NULL,
    pillar text,
    suggested_format text CHECK (suggested_format IN ('reel','image')),
    confidence text NOT NULL CHECK (confidence IN ('none','low','medium','high')),
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    researched_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','rejected','planned','expired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, dedupe_key)
  )`,
  `CREATE INDEX IF NOT EXISTS content_opportunities_account_idx ON content_opportunities (account_id, status, researched_at DESC)`,

  `CREATE TABLE IF NOT EXISTS content_plan_items (
    item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES ig_accounts(account_id),
    generation_id text NOT NULL,
    plan_date date NOT NULL,
    format text NOT NULL CHECK (format IN ('reel','image')),
    pillar text NOT NULL,
    topic text NOT NULL,
    hook text,
    rationale text NOT NULL,
    opportunity_id uuid REFERENCES content_opportunities(opportunity_id),
    evidence_class text NOT NULL,
    confidence text NOT NULL CHECK (confidence IN ('none','low','medium','high')),
    performance_basis jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','edited','rejected','converted')),
    board_card_id text,
    edited_by_owner boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS content_plan_items_account_idx ON content_plan_items (account_id, plan_date)`
];

export const down = [
  `DROP TABLE IF EXISTS content_plan_items`,
  `DROP TABLE IF EXISTS content_opportunities`,
  `ALTER TABLE agent_settings DROP COLUMN IF EXISTS strategy`
];
