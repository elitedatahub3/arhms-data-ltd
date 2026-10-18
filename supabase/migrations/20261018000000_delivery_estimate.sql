-- ════════════════════════════════════════════════════════════════════════════
-- Live delivery estimate ("Delivery Status" widget, buy-confirm line, USSD line)
--
-- The estimate needs to know WHEN an order was delivered. orders never recorded
-- that — updated_at moves on any later write (refund, note, supplier sync), so
-- it can't stand in. delivered_at is stamped by trigger rather than at each of
-- the ~130 places that write orders, so no completion path can miss it.
--
-- No backfill: updated_at is the only candidate and it is unreliable. Each
-- channel reads "No recent orders" until its first delivery after this runs.
--
-- airtime_orders already has fulfilled_at (set by lib/airtime-order-completion
-- .ts); the trigger only fills it when a path completes without setting it.
--
-- get_delivery_signals() returns, per channel, the raw timestamps the pure
-- logic in lib/delivery-estimate.ts turns into the numbers customers see:
--   C = the most recently PLACED completed order (by created_at, never by
--       delivered_at — a straggler that resolves late must not become "latest")
--   P = the OLDEST in-flight order placed after C. Anchored to C.created_at,
--       not C.delivered_at, so a sibling placed with C that is still stuck is
--       counted, while backlog from before C stays excluded.
--
-- Safe in either order with the code: until this runs, /api/delivery-status
-- returns 503, the widget hides itself and the confirm lines show nothing.
-- On a large orders table, run the two CREATE INDEX statements on their own
-- with CONCURRENTLY added.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.stamp_order_delivered_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.status = 'completed' THEN
        IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed' THEN
            NEW.delivered_at := COALESCE(NEW.delivered_at, now());
        END IF;
    ELSE
        -- Left 'completed' (retry, refund): it is no longer a delivery.
        NEW.delivered_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_delivered_at ON public.orders;
CREATE TRIGGER trg_orders_delivered_at
    BEFORE INSERT OR UPDATE OF status ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.stamp_order_delivered_at();

CREATE OR REPLACE FUNCTION public.stamp_airtime_fulfilled_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.status = 'completed'
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
        NEW.fulfilled_at := COALESCE(NEW.fulfilled_at, now());
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_airtime_orders_fulfilled_at ON public.airtime_orders;
CREATE TRIGGER trg_airtime_orders_fulfilled_at
    BEFORE INSERT OR UPDATE OF status ON public.airtime_orders
    FOR EACH ROW EXECUTE FUNCTION public.stamp_airtime_fulfilled_at();

CREATE INDEX IF NOT EXISTS idx_orders_network_status_created
    ON public.orders (network, status, created_at);
CREATE INDEX IF NOT EXISTS idx_airtime_orders_status_created
    ON public.airtime_orders (status, created_at);

-- Admin "mark this channel down" switch. Service role only; read through the RPC.
CREATE TABLE IF NOT EXISTS public.delivery_channel_overrides (
    channel           TEXT PRIMARY KEY,
    is_manually_down  BOOLEAN NOT NULL DEFAULT false,
    reason            TEXT,
    since             TIMESTAMPTZ,
    updated_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.delivery_channel_overrides ENABLE ROW LEVEL SECURITY;

-- Channel names must match CHANNELS in lib/delivery-estimate.ts.
CREATE OR REPLACE FUNCTION public.get_delivery_signals()
RETURNS TABLE (
    channel          TEXT,
    c_created_at     TIMESTAMPTZ,
    c_delivered_at   TIMESTAMPTZ,
    p_created_at     TIMESTAMPTZ,
    is_manually_down BOOLEAN,
    down_reason      TEXT,
    down_since       TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH data_channels AS (
        SELECT * FROM (VALUES ('MTN', 1), ('Telecel', 2), ('AT-iShare', 3), ('AT-BigTime', 4)) v(channel, ord)
    ),
    data_signals AS (
        SELECT d.ord, d.channel, c.created_at AS c_created_at, c.delivered_at AS c_delivered_at, p.created_at AS p_created_at
        FROM data_channels d
        LEFT JOIN LATERAL (
            SELECT o.created_at, o.delivered_at
            FROM orders o
            WHERE o.network = d.channel AND o.status = 'completed' AND o.delivered_at IS NOT NULL
            ORDER BY o.created_at DESC
            LIMIT 1
        ) c ON true
        LEFT JOIN LATERAL (
            SELECT o.created_at
            FROM orders o
            WHERE o.network = d.channel
              AND o.status IN ('pending', 'processing')
              AND c.created_at IS NOT NULL
              AND o.created_at > c.created_at
            ORDER BY o.created_at ASC
            LIMIT 1
        ) p ON true
    ),
    airtime_signal AS (
        SELECT 5 AS ord, 'Airtime'::text AS channel,
               c.created_at AS c_created_at, c.fulfilled_at AS c_delivered_at, p.created_at AS p_created_at
        FROM (SELECT 1) one
        LEFT JOIN LATERAL (
            SELECT a.created_at, a.fulfilled_at
            FROM airtime_orders a
            WHERE a.status = 'completed' AND a.fulfilled_at IS NOT NULL
            ORDER BY a.created_at DESC
            LIMIT 1
        ) c ON true
        LEFT JOIN LATERAL (
            SELECT a.created_at
            FROM airtime_orders a
            WHERE a.status IN ('pending', 'processing')
              AND c.created_at IS NOT NULL
              AND a.created_at > c.created_at
            ORDER BY a.created_at ASC
            LIMIT 1
        ) p ON true
    ),
    signals AS (
        SELECT * FROM data_signals
        UNION ALL
        SELECT * FROM airtime_signal
    )
    SELECT s.channel, s.c_created_at, s.c_delivered_at, s.p_created_at,
           COALESCE(ov.is_manually_down, false), ov.reason, ov.since
    FROM signals s
    LEFT JOIN delivery_channel_overrides ov ON ov.channel = s.channel
    ORDER BY s.ord;
$$;

REVOKE ALL ON FUNCTION public.get_delivery_signals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_delivery_signals() TO service_role;
