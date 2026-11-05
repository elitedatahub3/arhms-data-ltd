-- ==============================================================================
-- COMBINED PENDING MIGRATIONS FOR SUPABASE SQL EDITOR
-- Safe to run multiple times: all statements are idempotent with IF NOT EXISTS,
-- ON CONFLICT DO NOTHING, DROP POLICY IF EXISTS, and EXCEPTION blocks.
-- ==============================================================================

-- ==============================================================================
-- 1. 20260905000000_utility_supplier_reference_index.sql
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_utility_orders_external_txn
    ON public.utility_orders(external_transaction_id)
    WHERE external_transaction_id IS NOT NULL;


-- ==============================================================================
-- 2. 20260905010000_shop_utility_pricing.sql
-- ==============================================================================
ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS utility_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
    ALTER TABLE public.shop_profiles
        ADD CONSTRAINT shop_profiles_utility_fee_percent_range
        CHECK (utility_fee_percent >= 0 AND utility_fee_percent <= 5);
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN duplicate_table  THEN NULL;
END $$;

ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS utilities_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES public.shop_profiles(id);
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS shop_name TEXT;
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS reseller_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS reseller_split JSONB;
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS reseller_credited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_utility_orders_shop ON public.utility_orders(shop_id);

INSERT INTO public.admin_settings (key, value) VALUES
    ('utility_total_markup_cap_percent', '5')
ON CONFLICT (key) DO NOTHING;


-- ==============================================================================
-- 3. 20260906000000_utility_surface_toggles.sql
-- ==============================================================================
INSERT INTO public.admin_settings (key, value) VALUES
    ('utility_dashboard_enabled',  'true'),
    ('utility_storefront_enabled', 'true')
ON CONFLICT (key) DO NOTHING;


-- ==============================================================================
-- 4. 20260907000000_afa_rc_api_v2.sql
-- ==============================================================================
ALTER TABLE public.afa_orders
    ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES public.api_keys(id) ON DELETE SET NULL;

ALTER TABLE public.results_checker_orders
    ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES public.api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_afa_orders_api_key ON public.afa_orders(api_key_id);
CREATE INDEX IF NOT EXISTS idx_results_checker_orders_api_key ON public.results_checker_orders(api_key_id);


-- ==============================================================================
-- 5. 20260910000000_airtime_direct_pay.sql
-- ==============================================================================
ALTER TABLE public.airtime_orders
    ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'wallet';

ALTER TABLE public.airtime_orders
    ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid';

DO $$ BEGIN
    ALTER TABLE public.airtime_orders
        ADD CONSTRAINT airtime_orders_payment_method_check
        CHECK (payment_method IN ('wallet', 'gateway'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.airtime_orders
        ADD CONSTRAINT airtime_orders_payment_status_check
        CHECK (payment_status IN ('pending', 'paid', 'refunded'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;


-- ==============================================================================
-- 6. 20260912000000_customer_sms.sql
-- ==============================================================================
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_sender_ids_claimed
  ON public.sms_sender_ids (lower(sender))
  WHERE status IN ('submitted', 'approved');

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

CREATE INDEX IF NOT EXISTS idx_sms_campaigns_pending
  ON public.sms_campaigns(created_at) WHERE status IN ('queued', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_campaigns_reference
  ON public.sms_campaigns (account_id, reference) WHERE reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.sms_messages (
    id                  UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    campaign_id         UUID        REFERENCES public.sms_campaigns(id) ON DELETE CASCADE NOT NULL,
    account_id          UUID        REFERENCES public.sms_accounts(id) ON DELETE CASCADE NOT NULL,
    recipient           TEXT        NOT NULL,
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
    DROP POLICY IF EXISTS "sms_accounts: owner select" ON public.sms_accounts;
    CREATE POLICY "sms_accounts: owner select" ON public.sms_accounts FOR SELECT
        USING (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_accounts: admin all" ON public.sms_accounts;
    CREATE POLICY "sms_accounts: admin all" ON public.sms_accounts FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_sender_ids: owner select" ON public.sms_sender_ids;
    CREATE POLICY "sms_sender_ids: owner select" ON public.sms_sender_ids FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_sender_ids: admin all" ON public.sms_sender_ids;
    CREATE POLICY "sms_sender_ids: admin all" ON public.sms_sender_ids FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_credit_purchases: owner select" ON public.sms_credit_purchases;
    CREATE POLICY "sms_credit_purchases: owner select" ON public.sms_credit_purchases FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_credit_purchases: admin all" ON public.sms_credit_purchases;
    CREATE POLICY "sms_credit_purchases: admin all" ON public.sms_credit_purchases FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_contacts: owner select" ON public.sms_contacts;
    CREATE POLICY "sms_contacts: owner select" ON public.sms_contacts FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_contacts: admin all" ON public.sms_contacts;
    CREATE POLICY "sms_contacts: admin all" ON public.sms_contacts FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_groups: owner select" ON public.sms_groups;
    CREATE POLICY "sms_groups: owner select" ON public.sms_groups FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_groups: admin all" ON public.sms_groups;
    CREATE POLICY "sms_groups: admin all" ON public.sms_groups FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_group_members: owner select" ON public.sms_group_members;
    CREATE POLICY "sms_group_members: owner select" ON public.sms_group_members FOR SELECT
        USING (EXISTS (
            SELECT 1 FROM public.sms_groups g
            JOIN public.sms_accounts a ON a.id = g.account_id
            WHERE g.id = group_id AND a.user_id = (SELECT auth.uid())
        ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_group_members: admin all" ON public.sms_group_members;
    CREATE POLICY "sms_group_members: admin all" ON public.sms_group_members FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_campaigns: owner select" ON public.sms_campaigns;
    CREATE POLICY "sms_campaigns: owner select" ON public.sms_campaigns FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_campaigns: admin all" ON public.sms_campaigns;
    CREATE POLICY "sms_campaigns: admin all" ON public.sms_campaigns FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_messages: owner select" ON public.sms_messages;
    CREATE POLICY "sms_messages: owner select" ON public.sms_messages FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_messages: admin all" ON public.sms_messages;
    CREATE POLICY "sms_messages: admin all" ON public.sms_messages FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_credit_bundles: read active" ON public.sms_credit_bundles;
    CREATE POLICY "sms_credit_bundles: read active" ON public.sms_credit_bundles FOR SELECT
        USING (is_active = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "sms_credit_bundles: admin all" ON public.sms_credit_bundles;
    CREATE POLICY "sms_credit_bundles: admin all" ON public.sms_credit_bundles FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

    IF v_new_balance IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
    END IF;

    RETURN v_new_balance;
END;
$$;

REVOKE ALL ON FUNCTION debit_sms_credits(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION debit_sms_credits(UUID, INTEGER) TO service_role;

INSERT INTO public.admin_settings (key, value) VALUES
  ('sms_customer_enabled',        '"true"'),
  ('sms_unlock_price_customer',   '"10"'),
  ('sms_unlock_price_agent',      '"10"'),
  ('sms_unlock_price_dealer',     '"10"'),
  ('sms_unlock_price_sub',        '"10"'),
  ('sms_pool_senders',            '""'),
  ('sms_inline_send_max',         '"100"')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.sms_credit_bundles (name, credits, price, sort_order)
SELECT * FROM (VALUES
    ('Starter',  100,   5.00::DECIMAL(12,2), 1),
    ('Standard', 500,  22.00::DECIMAL(12,2), 2),
    ('Growth',   1000, 40.00::DECIMAL(12,2), 3),
    ('Bulk',     5000, 180.00::DECIMAL(12,2), 4)
) AS seed(name, credits, price, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.sms_credit_bundles);


-- ==============================================================================
-- 7. 20260917000000_api_order_webhooks.sql
-- ==============================================================================
ALTER TABLE orders     ADD COLUMN IF NOT EXISTS api_webhook_sent_at timestamptz;
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS api_webhook_sent_at timestamptz;

UPDATE orders
   SET api_webhook_sent_at = now()
 WHERE api_key_id IS NOT NULL
   AND status IN ('completed', 'failed')
   AND api_webhook_sent_at IS NULL;

UPDATE afa_orders
   SET api_webhook_sent_at = now()
 WHERE api_key_id IS NOT NULL
   AND status IN ('completed', 'failed')
   AND api_webhook_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS orders_api_webhook_pending_idx
    ON orders (updated_at)
    WHERE api_key_id IS NOT NULL
      AND api_webhook_sent_at IS NULL
      AND status IN ('completed', 'failed');

CREATE INDEX IF NOT EXISTS afa_orders_api_webhook_pending_idx
    ON afa_orders (updated_at)
    WHERE api_key_id IS NOT NULL
      AND api_webhook_sent_at IS NULL
      AND status IN ('completed', 'failed');


-- ==============================================================================
-- 8. 20260918000000_commission_withdrawals.sql
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.commission_withdrawals (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id             UUID NOT NULL REFERENCES public.commission_wallets(id) ON DELETE CASCADE,
    user_id               UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    amount                NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    fee                   NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    net_amount            NUMERIC(12,2) NOT NULL CHECK (net_amount > 0),
    payment_type          TEXT NOT NULL CHECK (payment_type IN ('momo', 'bank')),
    network               TEXT,
    momo_number           TEXT,
    account_number        TEXT,
    account_name          TEXT NOT NULL,
    bank_id               TEXT,
    bank_name             TEXT,
    branch                TEXT,
    status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'moolre_pending', 'completed', 'rejected')),
    admin_note            TEXT,
    balance_snapshot      NUMERIC(12,2),
    moolre_transaction_id TEXT,
    moolre_external_ref   TEXT,
    moolre_status         INTEGER,
    processed_at          TIMESTAMPTZ,
    processed_by          UUID REFERENCES public.users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commission_withdrawals_user    ON public.commission_withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_commission_withdrawals_created ON public.commission_withdrawals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commission_withdrawals_status  ON public.commission_withdrawals(status);

ALTER TABLE public.commission_withdrawals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "commission_withdrawals: owner read" ON public.commission_withdrawals;
CREATE POLICY "commission_withdrawals: owner read" ON public.commission_withdrawals
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "commission_withdrawals: admin read" ON public.commission_withdrawals;
CREATE POLICY "commission_withdrawals: admin read" ON public.commission_withdrawals
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.users u
                WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'sub-admin'))
    );

CREATE OR REPLACE FUNCTION refund_commission_withdrawal(
    p_user_id UUID,
    p_amount  NUMERIC
)
RETURNS TABLE(wallet_id UUID, new_balance NUMERIC, new_total_withdrawn NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _user_id ALIAS FOR $1;
    _amount  ALIAS FOR $2;
    v_wallet_id     UUID;
    v_new_balance   NUMERIC;
    v_new_withdrawn NUMERIC;
BEGIN
    IF _amount IS NULL OR _amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    UPDATE public.commission_wallets
    SET balance         = balance + _amount,
        total_withdrawn = GREATEST(COALESCE(total_withdrawn, 0) - _amount, 0),
        updated_at      = NOW()
    WHERE owner_id = _user_id
    RETURNING id, balance, COALESCE(total_withdrawn, 0)
    INTO v_wallet_id, v_new_balance, v_new_withdrawn;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    RETURN QUERY SELECT v_wallet_id, v_new_balance, v_new_withdrawn;
END;
$$;

INSERT INTO public.admin_settings (key, value)
SELECT 'commission_min_withdrawal', '"10"'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.admin_settings WHERE key = 'commission_min_withdrawal');

INSERT INTO public.admin_settings (key, value)
SELECT 'commission_withdrawal_fee_percent', '"0"'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.admin_settings WHERE key = 'commission_withdrawal_fee_percent');

INSERT INTO public.admin_settings (key, value)
SELECT 'commission_withdrawal_fee_flat', '"0"'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.admin_settings WHERE key = 'commission_withdrawal_fee_flat');


-- ==============================================================================
-- 9. 20260920000000_shop_payment_meta.sql
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.shop_payment_meta (
    reference   text PRIMARY KEY,
    metadata    jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS shop_payment_meta_expires_at_idx
    ON public.shop_payment_meta (expires_at);

ALTER TABLE public.shop_payment_meta ENABLE ROW LEVEL SECURITY;


-- ==============================================================================
-- 10. 20260928000000_add_bundleportal_fulfillment_method.sql
-- ==============================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bundleportal_reference TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS bundleportal_reference TEXT;

DO $$ BEGIN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;
    ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_method_check
      CHECK (fulfillment_method IN ('auto', 'manual', 'codecraft', 'datakazina', 'kingflexy', 'eazydata', 'agentportal', 'netpulse', 'hendylinks', 'bundleportal'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_bundleportal_processing
  ON orders (fulfillment_method, status)
  WHERE fulfillment_method = 'bundleportal' AND status = 'processing';

CREATE INDEX IF NOT EXISTS idx_shop_orders_bundleportal_processing
  ON shop_orders (fulfilled_by, status)
  WHERE fulfilled_by = 'bundleportal' AND status = 'processing';

CREATE INDEX IF NOT EXISTS idx_orders_bundleportal_reference
  ON orders (bundleportal_reference)
  WHERE bundleportal_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shop_orders_bundleportal_reference
  ON shop_orders (bundleportal_reference)
  WHERE bundleportal_reference IS NOT NULL;
