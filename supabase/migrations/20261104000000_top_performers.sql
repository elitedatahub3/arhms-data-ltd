-- ============================================================================
-- Monthly Top Performers
-- ============================================================================
-- Two monthly leaderboards ranked by GHS of COMPLETED sales:
--
--   dashboard — what a user bought themselves, on the website or through the
--               developer API (orders.source 'web' and 'api' both count).
--   shop      — what a shop sold through its storefront or USSD code, credited
--               to the owner of the SELLING shop (sub-agents rank for their own
--               shop; their uplines do not inherit the sale).
--
-- Products: data, AFA, results checkers, airtime, utility bills, Standard Bundles.
--
-- Double-count traps this function is built around:
--   * every shop data/airtime sale is mirrored into `orders` with shop_order_id
--     set (lib/shop-order-processor.ts) — dashboard counts shop_order_id IS NULL;
--   * shop airtime is ALSO mirrored into airtime_orders with shop_id set — the
--     shop board counts it from shop_orders only, never from airtime_orders.
--
-- Months are Ghana calendar months (Africa/Accra, which is UTC+0).
-- Admin and sub-admin accounts never rank.
--
-- top_performer_winners is the frozen top 3 of each closed month, written by
-- /api/cron/top-performers-winners, which then SMSes each winner to contact the
-- admin for their reward. Rewards are paid by hand; this table only records
-- who won, whether the SMS went out, and whether the prize was claimed.
-- ============================================================================

-- plpgsql + dynamic SQL so bundle_orders is only read where it exists: the
-- Standard Bundles migration (20261026000000) may not have been run yet, and a
-- LANGUAGE sql body naming a missing table would fail this whole migration.
CREATE OR REPLACE FUNCTION public.top_performers_totals(
    p_board text,
    p_start timestamptz,
    p_end   timestamptz
)
RETURNS TABLE (user_id uuid, total numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    has_bundles boolean := to_regclass('public.bundle_orders') IS NOT NULL;
    sales text;
BEGIN
    IF p_board = 'dashboard' THEN
        -- What a user bought themselves: website + developer API.
        sales := $q$
            SELECT o.user_id AS uid, o.price AS amt
              FROM orders o
             WHERE o.status = 'completed'
               AND o.shop_order_id IS NULL
               AND COALESCE(o.payment_status, 'paid') <> 'refunded'
               AND o.created_at >= $1 AND o.created_at < $2
            UNION ALL
            SELECT a.user_id, a.total_paid
              FROM airtime_orders a
             WHERE a.status = 'completed'
               AND a.shop_id IS NULL
               AND a.created_at >= $1 AND a.created_at < $2
            UNION ALL
            SELECT u.user_id, u.total_paid
              FROM utility_orders u
             WHERE u.status = 'completed'
               AND u.shop_id IS NULL
               AND u.payment_status <> 'refunded'
               AND u.created_at >= $1 AND u.created_at < $2
            UNION ALL
            SELECT r.user_id, r.total_paid
              FROM results_checker_orders r
             WHERE r.status = 'completed'
               AND r.shop_id IS NULL
               AND r.created_at >= $1 AND r.created_at < $2
            UNION ALL
            SELECT f.user_id, f.payment_amount
              FROM afa_orders f
             WHERE f.status = 'completed'
               AND f.shop_id IS NULL
               AND COALESCE(f.payment_status, 'completed') = 'completed'
               AND f.created_at >= $1 AND f.created_at < $2
        $q$;
        IF has_bundles THEN
            sales := sales || $q$
            UNION ALL
            SELECT b.user_id, b.total_paid
              FROM bundle_orders b
             WHERE b.status = 'completed'
               AND b.source IN ('dashboard', 'api')
               AND b.payment_status = 'paid'
               AND b.created_at >= $1 AND b.created_at < $2
            $q$;
        END IF;
    ELSIF p_board = 'shop' THEN
        -- What a shop sold through its storefront or USSD code, credited to the
        -- owner of the selling shop. Shop airtime is counted from shop_orders
        -- only; its airtime_orders mirror is deliberately left out.
        sales := $q$
            SELECT sp.owner_id AS uid, s.selling_price AS amt
              FROM shop_orders s
              JOIN shop_profiles sp ON sp.id = s.shop_id
             WHERE s.status = 'completed'
               AND s.created_at >= $1 AND s.created_at < $2
            UNION ALL
            SELECT sp.owner_id, r.total_paid
              FROM results_checker_orders r
              JOIN shop_profiles sp ON sp.id = r.shop_id
             WHERE r.status = 'completed'
               AND r.created_at >= $1 AND r.created_at < $2
            UNION ALL
            SELECT sp.owner_id, u.total_paid
              FROM utility_orders u
              JOIN shop_profiles sp ON sp.id = u.shop_id
             WHERE u.status = 'completed'
               AND u.payment_status <> 'refunded'
               AND u.created_at >= $1 AND u.created_at < $2
            UNION ALL
            SELECT sp.owner_id, f.payment_amount
              FROM afa_orders f
              JOIN shop_profiles sp ON sp.id = f.shop_id
             WHERE f.status = 'completed'
               AND COALESCE(f.payment_status, 'completed') = 'completed'
               AND f.created_at >= $1 AND f.created_at < $2
        $q$;
        IF has_bundles THEN
            sales := sales || $q$
            UNION ALL
            SELECT COALESCE(sp.owner_id, b.user_id), b.total_paid
              FROM bundle_orders b
              LEFT JOIN shop_profiles sp ON sp.id = b.shop_id
             WHERE b.status = 'completed'
               AND b.source = 'storefront'
               AND b.payment_status = 'paid'
               AND b.created_at >= $1 AND b.created_at < $2
            $q$;
        END IF;
    ELSE
        RAISE EXCEPTION 'Unknown board %', p_board;
    END IF;

    RETURN QUERY EXECUTE
        'SELECT s.uid, SUM(s.amt)::numeric(14,2)
           FROM (' || sales || ') s
           JOIN users usr ON usr.id = s.uid
          WHERE COALESCE(usr.role, '''') NOT IN (''admin'', ''sub-admin'')
          GROUP BY s.uid
         HAVING SUM(s.amt) > 0'
        USING p_start, p_end;
END;
$$;

-- First name + last initial ("Anthony A."). Never the full surname.
CREATE OR REPLACE FUNCTION public.top_performers_display_name(p_first text, p_last text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN NULLIF(btrim(COALESCE(p_last, '')), '') IS NULL THEN COALESCE(NULLIF(btrim(p_first), ''), 'Seller')
        ELSE COALESCE(NULLIF(btrim(p_first), ''), 'Seller') || ' ' || upper(left(btrim(p_last), 1)) || '.'
    END;
$$;

-- The ranked board for the month containing p_month.
CREATE OR REPLACE FUNCTION public.top_performers_month(
    p_board text,
    p_month date,
    p_limit int DEFAULT 30
)
RETURNS TABLE (rank bigint, user_id uuid, display_name text, total numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH bounds AS (
        SELECT (date_trunc('month', p_month)::timestamp AT TIME ZONE 'Africa/Accra') AS s,
               ((date_trunc('month', p_month) + interval '1 month')::timestamp AT TIME ZONE 'Africa/Accra') AS e
    )
    SELECT row_number() OVER (ORDER BY t.total DESC, t.user_id) AS rank,
           t.user_id,
           public.top_performers_display_name(u.first_name, u.last_name),
           t.total
      FROM bounds b
     CROSS JOIN LATERAL public.top_performers_totals(p_board, b.s, b.e) t
      JOIN users u ON u.id = t.user_id
     ORDER BY t.total DESC, t.user_id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 100));
$$;

-- One user's place on a board: rank is NULL when they have no completed sales.
CREATE OR REPLACE FUNCTION public.top_performers_user_rank(
    p_board   text,
    p_month   date,
    p_user_id uuid
)
RETURNS TABLE (rank bigint, total numeric, participants bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH bounds AS (
        SELECT (date_trunc('month', p_month)::timestamp AT TIME ZONE 'Africa/Accra') AS s,
               ((date_trunc('month', p_month) + interval '1 month')::timestamp AT TIME ZONE 'Africa/Accra') AS e
    ),
    ranked AS (
        SELECT t.user_id, t.total,
               row_number() OVER (ORDER BY t.total DESC, t.user_id) AS rnk,
               count(*) OVER () AS n
          FROM bounds b
         CROSS JOIN LATERAL public.top_performers_totals(p_board, b.s, b.e) t
    )
    SELECT r.rnk, r.total, r.n FROM ranked r WHERE r.user_id = p_user_id
    UNION ALL
    SELECT NULL::bigint, 0::numeric, (SELECT count(*) FROM ranked)
     WHERE NOT EXISTS (SELECT 1 FROM ranked WHERE user_id = p_user_id);
$$;

-- These read every seller's totals: server (service role) only. The API routes
-- scope what each caller gets back.
REVOKE ALL ON FUNCTION public.top_performers_totals(text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.top_performers_month(text, date, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.top_performers_user_rank(text, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.top_performers_totals(text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.top_performers_month(text, date, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.top_performers_user_rank(text, date, uuid) TO service_role;

-- ----------------------------------------------------------------------------
-- Frozen winners of each closed month
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.top_performer_winners (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    month         date NOT NULL,              -- first day of the month won
    board         text NOT NULL CHECK (board IN ('dashboard', 'shop')),
    rank          smallint NOT NULL CHECK (rank BETWEEN 1 AND 3),
    user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    display_name  text NOT NULL,
    total         numeric(14,2) NOT NULL,
    prize_label   text,
    sms_sent_at   timestamptz,
    sms_error     text,
    claimed_at    timestamptz,
    claimed_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (month, board, rank)
);

CREATE INDEX IF NOT EXISTS top_performer_winners_user_idx ON public.top_performer_winners (user_id);

ALTER TABLE public.top_performer_winners ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (which bypasses RLS) reads or writes it.

-- Off until an admin turns it on at /admin/top-performers.
INSERT INTO public.admin_settings (key, value)
VALUES ('top_performers_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
