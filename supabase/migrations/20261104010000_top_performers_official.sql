-- ============================================================================
-- Top Performers: show official (admin) accounts, and better fallback names
-- ============================================================================
-- Run AFTER 20261104000000_top_performers.sql.
--
-- 1. Admin and sub-admin accounts (e.g. the ARHMSGH shop) used to be left out
--    entirely. They now appear at their true position by sales, flagged
--    is_official, but never take a rank number, a podium spot or a prize: `rank`
--    counts competing sellers only and is NULL for official rows.
-- 2. A user with no first name showed as "Seller". The shop board now falls
--    back to the shop name, the dashboard board to a masked phone number.
--
-- The return types change, so the functions are dropped and recreated.
-- ============================================================================

DROP FUNCTION IF EXISTS public.top_performers_month(text, date, int);
DROP FUNCTION IF EXISTS public.top_performers_user_rank(text, date, uuid);
DROP FUNCTION IF EXISTS public.top_performers_totals(text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.top_performers_display_name(text, text);

-- Same counting rules as before; the only change is that admin rows are kept
-- and flagged instead of filtered out.
CREATE OR REPLACE FUNCTION public.top_performers_totals(
    p_board text,
    p_start timestamptz,
    p_end   timestamptz
)
RETURNS TABLE (user_id uuid, total numeric, is_official boolean)
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
        'SELECT s.uid,
                SUM(s.amt)::numeric(14,2),
                bool_or(COALESCE(usr.role, '''') IN (''admin'', ''sub-admin''))
           FROM (' || sales || ') s
           JOIN users usr ON usr.id = s.uid
          GROUP BY s.uid
         HAVING SUM(s.amt) > 0'
        USING p_start, p_end;
END;
$$;

-- "Anthony A."; with no first name, the fallback (shop name or masked phone).
CREATE OR REPLACE FUNCTION public.top_performers_display_name(p_first text, p_last text, p_fallback text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN NULLIF(btrim(COALESCE(p_first, '')), '') IS NULL
            THEN COALESCE(NULLIF(btrim(COALESCE(p_fallback, '')), ''), 'Seller')
        WHEN NULLIF(btrim(COALESCE(p_last, '')), '') IS NULL
            THEN btrim(p_first)
        ELSE btrim(p_first) || ' ' || upper(left(btrim(p_last), 1)) || '.'
    END;
$$;

-- `rank` counts competing sellers only (NULL for official rows). Returns the top
-- p_limit competitors plus any official account that sold at least as much as
-- the last of them, ordered by sales.
CREATE OR REPLACE FUNCTION public.top_performers_month(
    p_board text,
    p_month date,
    p_limit int DEFAULT 30
)
RETURNS TABLE (rank bigint, user_id uuid, display_name text, total numeric, is_official boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH bounds AS (
        SELECT (date_trunc('month', p_month)::timestamp AT TIME ZONE 'Africa/Accra') AS s,
               ((date_trunc('month', p_month) + interval '1 month')::timestamp AT TIME ZONE 'Africa/Accra') AS e
    ),
    totals AS (
        SELECT t.* FROM bounds b CROSS JOIN LATERAL public.top_performers_totals(p_board, b.s, b.e) t
    ),
    ranked AS (
        SELECT t.user_id, t.total, t.is_official,
               CASE WHEN t.is_official THEN NULL
                    ELSE row_number() OVER (PARTITION BY t.is_official ORDER BY t.total DESC, t.user_id)
               END AS rnk
          FROM totals t
    ),
    lim AS (SELECT GREATEST(1, LEAST(COALESCE(p_limit, 30), 100)) AS n),
    cutoff AS (
        SELECT CASE WHEN count(*) >= (SELECT n FROM lim) THEN min(r.total) ELSE 0 END AS floor_total
          FROM ranked r WHERE r.rnk <= (SELECT n FROM lim)
    )
    SELECT r.rnk,
           r.user_id,
           public.top_performers_display_name(
               u.first_name,
               u.last_name,
               CASE WHEN p_board = 'shop' THEN sp.shop_name
                    WHEN length(u.phone_number) >= 7 THEN left(u.phone_number, 3) || '****' || right(u.phone_number, 3)
               END
           ),
           r.total,
           r.is_official
      FROM ranked r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN shop_profiles sp ON sp.owner_id = r.user_id
     WHERE r.rnk <= (SELECT n FROM lim)
        OR (r.is_official AND r.total >= (SELECT floor_total FROM cutoff))
     ORDER BY r.total DESC, r.user_id;
$$;

-- One user's competitive rank. Official accounts get rank NULL with their total.
CREATE OR REPLACE FUNCTION public.top_performers_user_rank(
    p_board   text,
    p_month   date,
    p_user_id uuid
)
RETURNS TABLE (rank bigint, total numeric, participants bigint, is_official boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH bounds AS (
        SELECT (date_trunc('month', p_month)::timestamp AT TIME ZONE 'Africa/Accra') AS s,
               ((date_trunc('month', p_month) + interval '1 month')::timestamp AT TIME ZONE 'Africa/Accra') AS e
    ),
    totals AS (
        SELECT t.* FROM bounds b CROSS JOIN LATERAL public.top_performers_totals(p_board, b.s, b.e) t
    ),
    ranked AS (
        SELECT t.user_id, t.total, t.is_official,
               CASE WHEN t.is_official THEN NULL
                    ELSE row_number() OVER (PARTITION BY t.is_official ORDER BY t.total DESC, t.user_id)
               END AS rnk
          FROM totals t
    ),
    n AS (SELECT count(*) FILTER (WHERE NOT is_official) AS competitors FROM ranked)
    SELECT r.rnk, r.total, (SELECT competitors FROM n), r.is_official
      FROM ranked r WHERE r.user_id = p_user_id
    UNION ALL
    SELECT NULL::bigint, 0::numeric, (SELECT competitors FROM n), false
     WHERE NOT EXISTS (SELECT 1 FROM ranked WHERE user_id = p_user_id);
$$;

REVOKE ALL ON FUNCTION public.top_performers_totals(text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.top_performers_month(text, date, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.top_performers_user_rank(text, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.top_performers_totals(text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.top_performers_month(text, date, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.top_performers_user_rank(text, date, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
