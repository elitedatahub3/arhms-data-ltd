-- ============================================================================
-- AFA registration for sub-agents
-- Created: 2026-08-19
--
-- A sub registers walk-in customers from their own portal, pays the price their
-- parent shop charges (shop_afa_pricing.selling_price), and the parent's shop
-- wallet is credited the margin over the platform's role price.
--
-- The storefront migration (20260819_shop_afa_pricing.sql) already added
-- shop_id / shop_name / shop_markup / cost_price / source / payment_status to
-- afa_orders, so this only widens `source` and adds the RPC.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Admit 'sub' as an order source
-- ----------------------------------------------------------------------------
ALTER TABLE public.afa_orders DROP CONSTRAINT IF EXISTS afa_orders_source_check;
ALTER TABLE public.afa_orders
  ADD CONSTRAINT afa_orders_source_check
  CHECK (source IN ('dashboard', 'storefront', 'sub'));

-- ----------------------------------------------------------------------------
-- 2. process_sub_afa_order
--
-- Modelled on process_afa_order (supabase/add_afa_date_of_birth.sql) — same
-- wallet lock, same failure modes, same return shape — with shop attribution
-- written in the SAME transaction as the debit, so a sub order can never exist
-- without the parent it must pay.
--
-- Deliberately a NEW function rather than extra defaulted params on
-- process_afa_order: CREATE OR REPLACE with a different argument list produces
-- an overload, not a replacement, and PostgREST would then have two candidates
-- to disambiguate for the existing 4-arg call.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_sub_afa_order(
    p_user_id        UUID,
    p_amount         NUMERIC,
    p_form_data      JSONB,
    p_reference_code TEXT,
    p_shop_id        UUID,
    p_shop_name      TEXT,
    p_shop_markup    NUMERIC,
    p_cost_price     NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_wallet_id      UUID;
    v_wallet_balance NUMERIC;
    v_new_balance    NUMERIC;
    v_transaction_id UUID;
    v_order_id       UUID;
BEGIN
    -- Step 1: Lock the wallet row to prevent race conditions
    SELECT id, balance
        INTO v_wallet_id, v_wallet_balance
        FROM public.wallets
        WHERE user_id = p_user_id
        FOR UPDATE;

    -- Step 2: Validate balance
    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    IF v_wallet_balance < p_amount THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    -- Step 3: Deduct wallet balance
    UPDATE public.wallets
        SET
            balance     = balance - p_amount,
            total_spent = COALESCE(total_spent, 0) + p_amount,
            updated_at  = NOW()
        WHERE id = v_wallet_id
        RETURNING balance INTO v_new_balance;

    -- Step 4: Ledger row
    INSERT INTO public.wallet_transactions (
        wallet_id,
        user_id,
        type,
        amount,
        description,
        reference,
        source,
        status,
        metadata
    ) VALUES (
        v_wallet_id,
        p_user_id,
        'debit',
        p_amount,
        'MTN AFA Registration Fee',
        p_reference_code,
        'purchase',
        'completed',
        jsonb_build_object(
            'category', 'afa_order',
            'source',   'sub_afa_registration'
        )
    )
    RETURNING id INTO v_transaction_id;

    -- Step 5: The order, with the parent shop recorded as the credit target.
    --
    -- payment_status is 'completed' because the wallet has already been debited
    -- above — unlike a storefront order, there is no gateway to wait on, so the
    -- application enters the admin queue immediately.
    INSERT INTO public.afa_orders (
        user_id,
        full_name,
        phone,
        ghana_card,
        id_type,
        id_number,
        location,
        region,
        occupation,
        date_of_birth,
        notes,
        status,
        payment_status,
        source,
        shop_id,
        shop_name,
        shop_markup,
        cost_price,
        payment_amount,
        reference_code,
        transaction_id
    ) VALUES (
        p_user_id,
        p_form_data->>'full_name',
        p_form_data->>'phone',
        p_form_data->>'id_number',   -- backward compat: ghana_card = id_number
        p_form_data->>'id_type',
        p_form_data->>'id_number',
        p_form_data->>'location',
        p_form_data->>'region',
        'Farmer',
        (p_form_data->>'date_of_birth')::DATE,
        p_form_data->>'notes',
        'pending',
        'completed',
        'sub',
        p_shop_id,
        p_shop_name,
        p_shop_markup,
        p_cost_price,
        p_amount,
        p_reference_code,
        v_transaction_id
    )
    RETURNING id INTO v_order_id;

    RETURN json_build_object(
        'order_id',       v_order_id,
        'transaction_id', v_transaction_id,
        'new_balance',    v_new_balance
    );
END;
$$;
