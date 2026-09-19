-- Commission withdrawals: a partner asks to be paid out, an admin approves.
--
-- Modelled on the shop flow (shop_wallet_transactions where type='withdrawal'), but in
-- its own table: commission_transactions is an EARNINGS ledger — its source CHECK allows
-- only 'airtime'/'utility' and its amount must be positive, so a payout cannot live
-- there without loosening both constraints on the table that feeds
-- GET /api/v2/commission/transactions.
--
-- The balance is debited at REQUEST time by deduct_commission_wallet_balance, which
-- already exists and guards the balance inside its UPDATE. That is what stops a partner
-- queueing two withdrawals worth more than they hold.

CREATE TABLE IF NOT EXISTS public.commission_withdrawals (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id             UUID NOT NULL REFERENCES public.commission_wallets(id) ON DELETE CASCADE,
    user_id               UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

    amount                NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    fee                   NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    net_amount            NUMERIC(12,2) NOT NULL CHECK (net_amount > 0),

    -- Payout destination. Same split as shop_wallet_transactions: a MoMo number and a
    -- bank account number are different things and are never stored in one column.
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
-- The admin queue and the Moolre sweep both read by status.
CREATE INDEX IF NOT EXISTS idx_commission_withdrawals_status  ON public.commission_withdrawals(status);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Reads only, exactly as commission_wallets: every write goes through the service
-- role, so a partner cannot insert their own "completed" payout.
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

-- ─── Refund on rejection ─────────────────────────────────────────────────────
-- NOT credit_commission_wallet_balance: that one raises total_earned, which would book
-- a returned payout as new earnings and inflate every lifetime figure. A refund is the
-- exact inverse of the debit — balance back up, total_withdrawn back down.
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
        -- GREATEST guards the floor: a manual correction could otherwise drive a
        -- lifetime total negative, which no screen is prepared to render.
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

-- ─── Settings ────────────────────────────────────────────────────────────────
-- Admin-editable, like commission_share_percent. No fee and a GHS 10 floor.
--
-- Values are JSON STRINGS, not JSON numbers: admin_settings.value is jsonb and every
-- existing numeric setting is stored quoted ("50"), which is what the admin form writes
-- back. Storing 10 here instead of "10" would read back as a different JSON type than
-- the same setting has after anyone edits it once.
--
-- WHERE NOT EXISTS rather than ON CONFLICT so this does not depend on `key` carrying a
-- unique constraint, and re-running never overwrites a value an admin has since changed.
INSERT INTO public.admin_settings (key, value)
SELECT 'commission_min_withdrawal', '"10"'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.admin_settings WHERE key = 'commission_min_withdrawal');

INSERT INTO public.admin_settings (key, value)
SELECT 'commission_withdrawal_fee_percent', '"0"'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.admin_settings WHERE key = 'commission_withdrawal_fee_percent');

INSERT INTO public.admin_settings (key, value)
SELECT 'commission_withdrawal_fee_flat', '"0"'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.admin_settings WHERE key = 'commission_withdrawal_fee_flat');
