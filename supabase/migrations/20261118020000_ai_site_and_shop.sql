-- ============================================================================
-- ARHMS AI: site answers, shop assistant, monthly limits with paid resets
-- ============================================================================
-- All tables: RLS ON with NO policies -> only server code (service role) can
-- read or write them. Safe to run more than once.
-- ============================================================================

-- 1. Questions ARHMS AI could not answer (admin "Couldn't answer" list).
CREATE TABLE IF NOT EXISTS public.ai_unanswered (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question    text NOT NULL CHECK (char_length(question) BETWEEN 3 AND 500),
    user_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
    shop_id     uuid,
    surface     text NOT NULL DEFAULT 'dashboard',
    resolved    boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_unanswered_open ON public.ai_unanswered (created_at DESC) WHERE NOT resolved;
ALTER TABLE public.ai_unanswered ENABLE ROW LEVEL SECURITY;

-- 2. Storefront assistant questions: counts a shop's monthly allowance AND the
--    per-visitor daily cap (ip_hash is a salted hash, never the raw IP).
CREATE TABLE IF NOT EXISTS public.ai_shop_questions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id     uuid NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    ip_hash     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_shop_questions_shop ON public.ai_shop_questions (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_shop_questions_ip ON public.ai_shop_questions (ip_hash, shop_id, created_at DESC);
ALTER TABLE public.ai_shop_questions ENABLE ROW LEVEL SECURITY;

-- 3. Paid resets: GHS 5 (dashboard user) / GHS 7 (shop) adds another full
--    monthly allowance. UNIQUE reference = a payment counts exactly once, even
--    when a webhook, a cron and the page's verify poll all confirm it.
CREATE TABLE IF NOT EXISTS public.ai_usage_purchases (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    shop_id          uuid REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    scope            text NOT NULL CHECK (scope IN ('dashboard', 'shop')),
    month            text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
    questions_added  integer NOT NULL CHECK (questions_added > 0),
    amount           numeric(10, 2) NOT NULL CHECK (amount >= 0),
    method           text NOT NULL CHECK (method IN ('wallet', 'momo')),
    reference        text NOT NULL UNIQUE,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    paid_at          timestamptz,
    CONSTRAINT ai_usage_purchases_shop_scope CHECK ((scope = 'shop') = (shop_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_purchases_user_month ON public.ai_usage_purchases (user_id, month) WHERE status = 'paid';
CREATE INDEX IF NOT EXISTS idx_ai_usage_purchases_shop_month ON public.ai_usage_purchases (shop_id, month) WHERE status = 'paid';
ALTER TABLE public.ai_usage_purchases ENABLE ROW LEVEL SECURITY;

-- 4. Shop owners can switch their storefront assistant off (on by default).
ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS ai_assistant_enabled boolean NOT NULL DEFAULT true;
