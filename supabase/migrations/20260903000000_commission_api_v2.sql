-- Developer API v2: a second key kind, and a wallet for what it earns.
--
-- Two things change shape here.
--
-- First, api_keys stops being one-row-per-user. A partner integrating bill payments
-- needs a key that CANNOT place data orders against their wallet, and vice versa, so
-- the kind is a property of the key rather than of the account. The unique constraint
-- moves from (user_id) to (user_id, kind).
--
-- Second, commission earnings get their own wallet. They are not spendable balance
-- topped up by the partner — they are revenue owed to them — and mixing the two into
-- public.wallets would make "how much do we owe our API partners" unanswerable. The
-- shape deliberately mirrors public.shop_wallets so the existing Moolre withdrawal
-- flow can be pointed at it without a second design.

-- ─── api_keys: two kinds per user ────────────────────────────────────────────
-- Keys are tagged by kind: kf_live_ for data, kf_cs_live_ for commission services.
-- The tags are different lengths, so api_keys.key_prefix stores the tag plus 8 hex
-- rather than a fixed 16 characters -- see prefixLengthFor() in lib/api-auth.ts.
-- Slicing an 11-character tag at 16 would leave 5 random characters, which collides
-- against api_keys_prefix_unique at a few hundred keys.
ALTER TABLE public.api_keys
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'standard';

DO $$ BEGIN
    ALTER TABLE public.api_keys
        ADD CONSTRAINT api_keys_kind_check CHECK (kind IN ('standard', 'commission'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Outbound webhooks (see lib/api-webhook.ts). Nullable: a key without a URL simply
-- never fires one, and the partner polls GET /api/v2/orders/:reference instead.
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS webhook_url    TEXT;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

-- The old constraint is what limited a user to a single key. Dropping it before the
-- replacement goes on means no window where a user could hold two standard keys.
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_user_id_unique;

-- Guarded on the catalog rather than on an exception alone. ADD CONSTRAINT ... UNIQUE
-- builds a backing INDEX, and a name clash on an index raises duplicate_table (42P07),
-- not the duplicate_object (42710) a CHECK constraint raises — so the usual
-- "EXCEPTION WHEN duplicate_object" idiom silently fails to make this idempotent.
-- Both are caught below in case the index exists without the constraint.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.api_keys'::regclass
          AND conname  = 'api_keys_user_id_kind_unique'
    ) THEN
        ALTER TABLE public.api_keys
            ADD CONSTRAINT api_keys_user_id_kind_unique UNIQUE (user_id, kind);
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN duplicate_table  THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_api_keys_kind ON public.api_keys(kind);

-- ─── commission_wallets ──────────────────────────────────────────────────────
-- Same columns and semantics as public.shop_wallets (supabase/shop_schema.sql).
-- No shop required — the wallet hangs off the user directly.
CREATE TABLE IF NOT EXISTS public.commission_wallets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
    balance         NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_earned    NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_withdrawn NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commission_wallets_owner ON public.commission_wallets(owner_id);

-- ─── commission_transactions ─────────────────────────────────────────────────
-- The statement behind GET /api/v2/commission/transactions. order_id is deliberately
-- untyped (no FK): it points into airtime_orders OR utility_orders depending on
-- `source`, and a single column cannot reference both.
CREATE TABLE IF NOT EXISTS public.commission_transactions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id     UUID NOT NULL REFERENCES public.commission_wallets(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    source        TEXT NOT NULL CHECK (source IN ('airtime', 'utility')),
    order_id      UUID,
    amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    description   TEXT NOT NULL,
    reference     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commission_tx_wallet  ON public.commission_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_commission_tx_user    ON public.commission_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_commission_tx_created ON public.commission_transactions(created_at DESC);
-- One earning per order. Belt to the commission_credited_at latch's braces: even if
-- the claim were somehow bypassed, the second insert cannot land.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_tx_order_unique
    ON public.commission_transactions(source, order_id)
    WHERE order_id IS NOT NULL;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Reads only. Every write goes through the SECURITY DEFINER RPCs below or the
-- service role, so there is no owner INSERT/UPDATE policy to abuse.
ALTER TABLE public.commission_wallets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "commission_wallets: owner read" ON public.commission_wallets;
CREATE POLICY "commission_wallets: owner read" ON public.commission_wallets
    FOR SELECT USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "commission_wallets: admin read" ON public.commission_wallets;
CREATE POLICY "commission_wallets: admin read" ON public.commission_wallets
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.users u
                WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'sub-admin'))
    );

DROP POLICY IF EXISTS "commission_tx: owner read" ON public.commission_transactions;
CREATE POLICY "commission_tx: owner read" ON public.commission_transactions
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "commission_tx: admin read" ON public.commission_transactions;
CREATE POLICY "commission_tx: admin read" ON public.commission_transactions
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.users u
                WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'sub-admin'))
    );

-- ─── Atomic credit ───────────────────────────────────────────────────────────
-- Upsert-then-update rather than SELECT-then-INSERT: two concurrent first-ever
-- earnings for the same user would otherwise race on the wallet row itself.
CREATE OR REPLACE FUNCTION credit_commission_wallet_balance(
    p_user_id UUID,
    p_amount  NUMERIC
)
RETURNS TABLE(wallet_id UUID, new_balance NUMERIC, new_total_earned NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _user_id ALIAS FOR $1;
    _amount  ALIAS FOR $2;
    v_wallet_id       UUID;
    v_new_balance     NUMERIC;
    v_new_total       NUMERIC;
BEGIN
    IF _amount IS NULL OR _amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    INSERT INTO public.commission_wallets (owner_id, balance, total_earned)
    VALUES (_user_id, 0, 0)
    ON CONFLICT (owner_id) DO NOTHING;

    UPDATE public.commission_wallets
    SET balance      = balance + _amount,
        total_earned = total_earned + _amount,
        updated_at   = NOW()
    WHERE owner_id = _user_id
    RETURNING id, balance, total_earned
    INTO v_wallet_id, v_new_balance, v_new_total;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    RETURN QUERY SELECT v_wallet_id, v_new_balance, v_new_total;
END;
$$;

-- ─── Atomic debit ────────────────────────────────────────────────────────────
-- Modelled on deduct_shop_wallet_balance: the balance guard lives in the WHERE
-- clause of a single UPDATE, so two concurrent withdrawals cannot both pass it.
CREATE OR REPLACE FUNCTION deduct_commission_wallet_balance(
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
    v_wallet_id UUID;
    v_new_balance   NUMERIC;
    v_new_withdrawn NUMERIC;
BEGIN
    UPDATE public.commission_wallets
    SET balance         = balance - _amount,
        total_withdrawn = COALESCE(total_withdrawn, 0) + _amount,
        updated_at      = NOW()
    WHERE owner_id = _user_id
      AND balance  >= _amount
    RETURNING id, balance, COALESCE(total_withdrawn, 0)
    INTO v_wallet_id, v_new_balance, v_new_withdrawn;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    RETURN QUERY SELECT v_wallet_id, v_new_balance, v_new_withdrawn;
END;
$$;

-- ─── Order attribution ───────────────────────────────────────────────────────
-- api_key_id is what makes an order EARN. An order without one came from the
-- dashboard or a storefront and pays nobody a commission.
--
-- commission_credited_at is the idempotency latch, claimed with a conditional
-- UPDATE before any money moves — the same pattern utility_orders.payment_status
-- uses for refunds, and for the same reason: the dispatcher, the Hubtel callback
-- and the reconciliation cron can all reach a completed order at once.
ALTER TABLE public.airtime_orders
    ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES public.api_keys(id) ON DELETE SET NULL;
ALTER TABLE public.airtime_orders
    ADD COLUMN IF NOT EXISTS commission_credited_at TIMESTAMPTZ;

ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES public.api_keys(id) ON DELETE SET NULL;
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS commission_credited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_airtime_orders_api_key ON public.airtime_orders(api_key_id);
CREATE INDEX IF NOT EXISTS idx_utility_orders_api_key ON public.utility_orders(api_key_id);

-- ─── Settings ────────────────────────────────────────────────────────────────
-- commission_share_pct is a percentage of the BILL, not of what Hubtel paid us, so
-- it is predictable for the partner. commission_share_cap_pct then clamps the result
-- to that percentage of the commission Hubtel actually reported, which is what stops
-- a low-commission service paying out more than it earned. Set the cap to 999 to
-- disable the clamp and pay the raw percentage regardless.
--
-- The *_api fee rows are 0 because a commission partner should pay the bill and
-- nothing else — they are compensated through the commission wallet, not by being
-- charged a markup and handed part of it back.
INSERT INTO public.admin_settings (key, value) VALUES
    ('api_v2_enabled',               'true'),
    ('api_commission_enabled',       'true'),
    ('api_commission_allowed_roles', '["agent","admin","sub-admin"]'),

    ('commission_share_pct',     '1.0'),
    ('commission_share_cap_pct', '100'),

    ('utility_fee_dstv_api',       '0'),
    ('utility_fee_gotv_api',       '0'),
    ('utility_fee_startimes_api',  '0'),
    ('utility_fee_ecg_api',        '0'),
    ('utility_fee_ghanawater_api', '0'),

    ('airtime_fee_mtn_api',     '0'),
    ('airtime_fee_telecel_api', '0'),
    ('airtime_fee_at_api',      '0')
ON CONFLICT (key) DO NOTHING;

-- Existing keys predate the column and are all data keys.
UPDATE public.api_keys SET kind = 'standard' WHERE kind IS NULL;
