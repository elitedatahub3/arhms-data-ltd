-- ============================================================
-- Customer SMS
--
-- A shop owner (or a sub-agent, independently of their upline) unlocks SMS
-- once, gets their own sender ID approved, buys credits, builds a customer
-- list, and sends bulk SMS under their own brand name.
--
-- Everything keys off users.id, not shop_profiles.id: a sub-agent's
-- users.role stays 'customer' and they may have no shop of their own yet,
-- but they still get their own account, sender ID, credits and contacts.
-- ============================================================


-- ============================================================
-- sms_accounts — one per owner
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sms_accounts (
    id               UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id          UUID        REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    shop_id          UUID        REFERENCES public.shop_profiles(id) ON DELETE SET NULL,
    status           TEXT        NOT NULL DEFAULT 'locked'
                                 CHECK (status IN ('locked', 'active', 'suspended')),
    credits          INTEGER     NOT NULL DEFAULT 0 CHECK (credits >= 0),
    total_purchased  INTEGER     NOT NULL DEFAULT 0,
    total_used       INTEGER     NOT NULL DEFAULT 0,
    default_sender   TEXT,
    unlocked_at      TIMESTAMPTZ,
    unlock_reference TEXT,
    unlock_amount    DECIMAL(12,2),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT sms_accounts_user_id_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_sms_accounts_shop_id ON public.sms_accounts(shop_id);
CREATE INDEX IF NOT EXISTS idx_sms_accounts_status  ON public.sms_accounts(status);


-- ============================================================
-- sms_sender_ids — the brand name messages are sent under
--
-- pending   → owner submitted it, nobody has looked yet
-- submitted → admin handed it to the provider / networks
-- approved  → the network accepted it; only now is it sendable
-- rejected  → refused, with a reason the owner can act on
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sms_sender_ids (
    id               UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    account_id       UUID        REFERENCES public.sms_accounts(id) ON DELETE CASCADE NOT NULL,
    sender           TEXT        NOT NULL,
    business_name    TEXT,
    ghana_card_url   TEXT,
    status           TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'submitted', 'approved', 'rejected')),
    rejection_reason TEXT,
    is_default       BOOLEAN     NOT NULL DEFAULT false,
    submitted_at     TIMESTAMPTZ,
    approved_at      TIMESTAMPTZ,
    approved_by      UUID        REFERENCES public.users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT sms_sender_ids_account_sender_unique UNIQUE (account_id, sender)
);

CREATE INDEX IF NOT EXISTS idx_sms_sender_ids_account ON public.sms_sender_ids(account_id);
CREATE INDEX IF NOT EXISTS idx_sms_sender_ids_status  ON public.sms_sender_ids(status);

-- A sender ID is globally unique at the network: once one account has it
-- submitted or approved, no other account may claim the same name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_sender_ids_claimed
  ON public.sms_sender_ids (lower(sender))
  WHERE status IN ('submitted', 'approved');


-- ============================================================
-- sms_credit_bundles — what an owner can buy
--
-- Seeded with placeholders; real prices are set in admin.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sms_credit_bundles (
    id         UUID          DEFAULT uuid_generate_v4() PRIMARY KEY,
    name       TEXT          NOT NULL,
    credits    INTEGER       NOT NULL CHECK (credits > 0),
    price      DECIMAL(12,2) NOT NULL CHECK (price >= 0),
    sort_order INTEGER       NOT NULL DEFAULT 0,
    is_active  BOOLEAN       NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ   DEFAULT NOW(),
    updated_at TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_credit_bundles_active
  ON public.sms_credit_bundles(sort_order) WHERE is_active = true;


-- ============================================================
-- sms_credit_purchases — the SMS-side ledger
--
-- The money row still lives in wallet_payments, so the existing payment
-- webhooks and verify-crons settle it exactly like every other purchase.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sms_credit_purchases (
    id           UUID          DEFAULT uuid_generate_v4() PRIMARY KEY,
    account_id   UUID          REFERENCES public.sms_accounts(id) ON DELETE CASCADE NOT NULL,
    bundle_id    UUID          REFERENCES public.sms_credit_bundles(id) ON DELETE SET NULL,
    credits      INTEGER       NOT NULL CHECK (credits > 0),
    amount       DECIMAL(12,2) NOT NULL,
    reference    TEXT          NOT NULL UNIQUE,
    provider     TEXT,
    status       TEXT          NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'completed', 'failed')),
    created_at   TIMESTAMPTZ   DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sms_credit_purchases_account ON public.sms_credit_purchases(account_id);
CREATE INDEX IF NOT EXISTS idx_sms_credit_purchases_status  ON public.sms_credit_purchases(status);


-- ============================================================
-- sms_contacts / sms_groups — the owner's customer list
--
-- phone is stored in the 233XXXXXXXXX form normalizeGhanaPhone() produces,
-- so the UNIQUE below actually collapses duplicates across the four ways a
-- contact can arrive (order import, manual, paste, CSV).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sms_contacts (
    id         UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    account_id UUID        REFERENCES public.sms_accounts(id) ON DELETE CASCADE NOT NULL,
    phone      TEXT        NOT NULL,
    name       TEXT,
    source     TEXT        NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('order', 'manual', 'import')),
    opted_out  BOOLEAN     NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT sms_contacts_account_phone_unique UNIQUE (account_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_sms_contacts_account
  ON public.sms_contacts(account_id) WHERE opted_out = false;

CREATE TABLE IF NOT EXISTS public.sms_groups (
    id         UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    account_id UUID        REFERENCES public.sms_accounts(id) ON DELETE CASCADE NOT NULL,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_groups_account_name
  ON public.sms_groups (account_id, lower(name));

CREATE TABLE IF NOT EXISTS public.sms_group_members (
    group_id   UUID        REFERENCES public.sms_groups(id)   ON DELETE CASCADE NOT NULL,
    contact_id UUID        REFERENCES public.sms_contacts(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (group_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_sms_group_members_contact ON public.sms_group_members(contact_id);


-- ============================================================
-- sms_campaigns / sms_messages — what was sent, and what happened to it
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sms_campaigns (
    id               UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    account_id       UUID        REFERENCES public.sms_accounts(id) ON DELETE CASCADE NOT NULL,
    message          TEXT        NOT NULL,
    sender_used      TEXT        NOT NULL,
    recipients_count INTEGER     NOT NULL DEFAULT 0,
    segments         INTEGER     NOT NULL DEFAULT 1,
    credits_charged  INTEGER     NOT NULL DEFAULT 0,
    status           TEXT        NOT NULL DEFAULT 'queued'
                                 CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'blocked')),
    source           TEXT        NOT NULL DEFAULT 'dashboard'
                                 CHECK (source IN ('dashboard', 'api')),
    reference        TEXT,
    scheduled_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sms_campaigns_account
  ON public.sms_campaigns(account_id, created_at DESC);

-- Drives the queue worker: oldest unfinished campaign first.
CREATE INDEX IF NOT EXISTS idx_sms_campaigns_pending
  ON public.sms_campaigns(created_at) WHERE status IN ('queued', 'processing');

-- The caller-supplied idempotency key: retrying a send with the same reference
-- returns the original campaign instead of sending and charging twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_campaigns_reference
  ON public.sms_campaigns (account_id, reference) WHERE reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.sms_messages (
    id                  UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    campaign_id         UUID        REFERENCES public.sms_campaigns(id) ON DELETE CASCADE NOT NULL,
    account_id          UUID        REFERENCES public.sms_accounts(id) ON DELETE CASCADE NOT NULL,
    recipient           TEXT        NOT NULL,
    -- 'sending' is the worker's claim marker: a row is moved into it before the
    -- provider call so a second cron tick cannot send it again, and any row left
    -- stranded there by a crash is swept back to 'queued' on the next tick.
    status              TEXT        NOT NULL DEFAULT 'queued'
                                    CHECK (status IN ('queued', 'sending', 'sent', 'delivered',
                                                      'undelivered', 'failed', 'expired', 'rejected')),
    provider_message_id TEXT,
    error               TEXT,
    status_updated_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_campaign ON public.sms_messages(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_sms_messages_account  ON public.sms_messages(account_id);


-- ============================================================
-- Row Level Security
--
-- Owners read their own rows; only the service role writes, because every
-- write is either paid for or spends credits and must go through a route
-- that checks entitlement first.
-- ============================================================

ALTER TABLE public.sms_accounts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_sender_ids       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_credit_bundles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_credit_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_contacts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_groups           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_group_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_campaigns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_messages         ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "sms_accounts: owner select" ON public.sms_accounts FOR SELECT
        USING (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_accounts: admin all" ON public.sms_accounts FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every child table hangs off sms_accounts, so ownership is the same EXISTS
-- check throughout.
DO $$ BEGIN
    CREATE POLICY "sms_sender_ids: owner select" ON public.sms_sender_ids FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_sender_ids: admin all" ON public.sms_sender_ids FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "sms_credit_purchases: owner select" ON public.sms_credit_purchases FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_credit_purchases: admin all" ON public.sms_credit_purchases FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "sms_contacts: owner select" ON public.sms_contacts FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_contacts: admin all" ON public.sms_contacts FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "sms_groups: owner select" ON public.sms_groups FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_groups: admin all" ON public.sms_groups FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "sms_group_members: owner select" ON public.sms_group_members FOR SELECT
        USING (EXISTS (
            SELECT 1 FROM public.sms_groups g
            JOIN public.sms_accounts a ON a.id = g.account_id
            WHERE g.id = group_id AND a.user_id = (SELECT auth.uid())
        ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_group_members: admin all" ON public.sms_group_members FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "sms_campaigns: owner select" ON public.sms_campaigns FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_campaigns: admin all" ON public.sms_campaigns FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "sms_messages: owner select" ON public.sms_messages FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_messages: admin all" ON public.sms_messages FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The bundle list is a price list: any signed-in owner may read the active ones.
DO $$ BEGIN
    CREATE POLICY "sms_credit_bundles: read active" ON public.sms_credit_bundles FOR SELECT
        USING (is_active = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_credit_bundles: admin all" ON public.sms_credit_bundles FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ============================================================
-- credit_sms_credits(account_id, amount) -> new balance
--
-- Used by a settled purchase and by the refund of a provider-rejected
-- message. total_purchased only counts bought credits, so refunds pass
-- p_purchased = false and do not inflate the lifetime figure.
-- ============================================================

CREATE OR REPLACE FUNCTION credit_sms_credits(
    p_account_id UUID,
    p_amount     INTEGER,
    p_purchased  BOOLEAN DEFAULT true
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _account_id ALIAS FOR $1;
    _amount     ALIAS FOR $2;
    _purchased  ALIAS FOR $3;
    v_new_balance INTEGER;
BEGIN
    IF _amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    UPDATE public.sms_accounts
    SET credits         = credits + _amount,
        total_purchased = total_purchased + CASE WHEN _purchased THEN _amount ELSE 0 END,
        -- A refund gives back a credit that was counted as used on debit.
        total_used      = GREATEST(0, total_used - CASE WHEN _purchased THEN 0 ELSE _amount END),
        updated_at      = NOW()
    WHERE id = _account_id
    RETURNING credits INTO v_new_balance;

    IF v_new_balance IS NULL THEN
        RAISE EXCEPTION 'SMS_ACCOUNT_NOT_FOUND';
    END IF;

    RETURN v_new_balance;
END;
$$;

REVOKE ALL ON FUNCTION credit_sms_credits(UUID, INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION credit_sms_credits(UUID, INTEGER, BOOLEAN) TO service_role;


-- ============================================================
-- debit_sms_credits(account_id, amount) -> new balance
--
-- Atomic in the same way as deduct_wallet_balance: the WHERE carries the
-- balance check, so two concurrent sends cannot both spend the same credit.
-- ============================================================

CREATE OR REPLACE FUNCTION debit_sms_credits(
    p_account_id UUID,
    p_amount     INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _account_id ALIAS FOR $1;
    _amount     ALIAS FOR $2;
    v_new_balance INTEGER;
BEGIN
    IF _amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    UPDATE public.sms_accounts
    SET credits    = credits - _amount,
        total_used = total_used + _amount,
        updated_at = NOW()
    WHERE id = _account_id
      AND status = 'active'
      AND credits >= _amount
    RETURNING credits INTO v_new_balance;

    -- No row updated means either not enough credits or the account is not
    -- active. The caller turns this into a 402 either way.
    IF v_new_balance IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
    END IF;

    RETURN v_new_balance;
END;
$$;

REVOKE ALL ON FUNCTION debit_sms_credits(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION debit_sms_credits(UUID, INTEGER) TO service_role;


-- ============================================================
-- Settings
--
-- admin_settings.value is JSONB, so every value is a quoted JSON *string* —
-- the readers compare with === 'true' and Number(), both of which break if
-- the value comes back as a JSON boolean or number.
--
-- The unlock is priced per tier like ussd_activation_price_*: a sub-agent's
-- users.role is 'customer', so the sub tier is resolved from sub_agents.
-- ============================================================

INSERT INTO public.admin_settings (key, value) VALUES
  ('sms_customer_enabled',        '"true"'),
  ('sms_unlock_price_customer',   '"10"'),
  ('sms_unlock_price_agent',      '"10"'),
  ('sms_unlock_price_dealer',     '"10"'),
  ('sms_unlock_price_sub',        '"10"'),
  -- Empty: a shop sends only under its own approved sender ID. Add a pool name
  -- in admin once one is registered with the provider.
  ('sms_pool_senders',            '""'),
  ('sms_inline_send_max',         '"100"')
ON CONFLICT (key) DO NOTHING;

-- Placeholder pricing. Real numbers are set by admin before launch.
INSERT INTO public.sms_credit_bundles (name, credits, price, sort_order)
SELECT * FROM (VALUES
    ('Starter',  100,   5.00::DECIMAL(12,2), 1),
    ('Standard', 500,  22.00::DECIMAL(12,2), 2),
    ('Growth',   1000, 40.00::DECIMAL(12,2), 3),
    ('Bulk',     5000, 180.00::DECIMAL(12,2), 4)
) AS seed(name, credits, price, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.sms_credit_bundles);
