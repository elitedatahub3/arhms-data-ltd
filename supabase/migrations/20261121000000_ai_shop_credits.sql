-- ============================================================================
-- ARHMS AI: shop assistant CREDITS (replaces the shop monthly allowance + GHS 7 reset)
-- ============================================================================
-- How a storefront answer is paid for (owner's model, 2026-11-21):
--   1. each customer gets free answers per day (admin: ai_storefront_daily_limit_per_ip)
--   2. after that, each answer uses 1 shop credit: this month's FREE credits first
--      (admin: ai_shop_free_monthly_credits), then BOUGHT credits (never expire)
--   3. no credits -> the customer waits until tomorrow
--
-- Bought credits live in ai_shop_credits.balance. Free monthly credits are not
-- stored: they are counted from ai_shop_questions rows with paid_by='shop_free'.
-- Server code only (RLS on, no policies; the RPCs are service_role only).
-- Safe to run more than once.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_shop_credits (
    shop_id     uuid PRIMARY KEY REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    balance     integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_shop_credits ENABLE ROW LEVEL SECURITY;

-- Who paid for each storefront answer.
ALTER TABLE public.ai_shop_questions
    ADD COLUMN IF NOT EXISTS paid_by text NOT NULL DEFAULT 'visitor_free';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_shop_questions_paid_by_check') THEN
        ALTER TABLE public.ai_shop_questions
            ADD CONSTRAINT ai_shop_questions_paid_by_check CHECK (paid_by IN ('visitor_free', 'shop_free', 'shop_credit'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_ai_shop_questions_shop_paid
    ON public.ai_shop_questions (shop_id, paid_by, created_at DESC);

-- Use one BOUGHT credit atomically. TRUE = a credit was used; FALSE = none left.
CREATE OR REPLACE FUNCTION public.consume_shop_credit(p_shop_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.ai_shop_credits
       SET balance = balance - 1, updated_at = now()
     WHERE shop_id = p_shop_id AND balance > 0;
    RETURN FOUND;
END;
$$;

-- Add bought credits (creates the row on first purchase). Returns the new balance.
CREATE OR REPLACE FUNCTION public.add_shop_credits(p_shop_id uuid, p_credits integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_balance integer;
BEGIN
    IF p_credits IS NULL OR p_credits <= 0 THEN
        RAISE EXCEPTION 'credits must be positive';
    END IF;
    INSERT INTO public.ai_shop_credits (shop_id, balance)
    VALUES (p_shop_id, p_credits)
    ON CONFLICT (shop_id) DO UPDATE
        SET balance = public.ai_shop_credits.balance + EXCLUDED.balance, updated_at = now()
    RETURNING balance INTO v_balance;
    RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_shop_credit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_shop_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_shop_credit(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_shop_credits(uuid, integer) TO service_role;
