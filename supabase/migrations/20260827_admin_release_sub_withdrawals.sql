-- ============================================================================
-- Fix: shop_wallet_transactions_status_check is missing half its valid states
-- ----------------------------------------------------------------------------
-- Two migrations define this constraint with DISJOINT value sets, and whichever
-- ran last silently outlawed the other's states:
--
--   supabase/migrations/20260412_moolre_withdrawals.sql:58
--       CHECK (status IN ('pending', 'moolre_pending', 'completed'))
--
--   migrations/20260703_sub_agents.sql:75
--       CHECK (status IN ('completed', 'pending', 'rejected', 'shop_owner_pending'))
--
-- Sub withdrawals do get written as 'shop_owner_pending' in production, so the
-- 20260703 version is the one live -- which means every "Pay via Moolre" payout
-- has been failing on a CHECK violation, because 'moolre_pending' is no longer
-- an allowed value. Releasing a sub withdrawal into the payout queue would hit
-- that same wall the moment an admin chose Moolre over manual payment.
--
-- The fix is the union of both sets. Nothing is removed, so no existing row can
-- be invalidated by it.
-- ============================================================================

DO $$
DECLARE
    v_constraint TEXT;
BEGIN
    -- Drop by the column the check constrains, not by name: the two migrations
    -- above used the same name, an older deploy may carry a differently-named
    -- status check, and a name match on '%status%' would also catch the
    -- sub_approval_status check -- dropping the wrong guard and leaving this
    -- bug in place. Looping covers a table carrying more than one.
    FOR v_constraint IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.conrelid = 'public.shop_wallet_transactions'::regclass
          AND c.contype = 'c'
          AND (
              SELECT array_agg(a.attname ORDER BY a.attname)
              FROM unnest(c.conkey) AS k(attnum)
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ) = ARRAY['status']
    LOOP
        EXECUTE format(
            'ALTER TABLE public.shop_wallet_transactions DROP CONSTRAINT %I',
            v_constraint
        );
    END LOOP;
END;
$$;

ALTER TABLE public.shop_wallet_transactions
    ADD CONSTRAINT shop_wallet_transactions_status_check
    CHECK (status IN (
        'pending',              -- in the admin payout queue
        'moolre_pending',       -- handed to Moolre, awaiting network confirmation
        'completed',            -- paid
        'rejected',             -- declined; funds returned to the wallet
        'shop_owner_pending'    -- sub request awaiting its upline Lead
    ));


-- ── Index: the admin queue now filters on 'shop_owner_pending' directly ──────
-- The existing idx_shop_wallet_transactions_escalate is partial on
-- (status, escalate_after) WHERE escalate_after IS NOT NULL, so it cannot serve
-- a plain status lookup for rows that never got an escalate_after.
CREATE INDEX IF NOT EXISTS idx_shop_wallet_transactions_status_type
    ON public.shop_wallet_transactions (status, type, created_at DESC);
