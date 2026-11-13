// Phase 4: creative packages. A package is DRAFT TEXT (caption, hashtags, hook, CTA, media prompt, alt text, reel script).
// It carries no media and no approval; it cannot be published. Image generation stays owner-triggered (paid by default).
export const id = "0005_creative";

export const up = [
  `CREATE TABLE IF NOT EXISTS creative_packages (
    package_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES ig_accounts(account_id),
    plan_item_id uuid NOT NULL REFERENCES content_plan_items(item_id),
    version integer NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','needs_fixes','applied','superseded','rejected')),
    source text NOT NULL CHECK (source IN ('gemini','template')),
    model text,
    caption text NOT NULL,
    hashtags jsonb NOT NULL DEFAULT '[]'::jsonb,
    hook text,
    cta text,
    media_prompt text NOT NULL,
    alt_text text,
    script jsonb NOT NULL DEFAULT '[]'::jsonb,
    validation jsonb NOT NULL DEFAULT '{}'::jsonb,
    edited_by_owner boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plan_item_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS creative_packages_account_idx ON creative_packages (account_id, created_at DESC)`
];

export const down = [`DROP TABLE IF EXISTS creative_packages`];
