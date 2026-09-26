-- HendyLinks supplier: DB objects the integration references.

-- 1. Columns to store the HendyLinks order id returned by POST /api/orders.
--    HendyLinks accepts no reference of our own on the create call, so their
--    integer order_id (stored as text) is the ONLY correlation key we have:
--    both the completion webhook and the reconciliation cron match on it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hendylinks_reference TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS hendylinks_reference TEXT;

-- 2. Allow 'hendylinks' as a fulfillment_method on orders.
--    Without this, stamping fulfillment_method='hendylinks' violates the CHECK
--    constraint. The dispatcher falls back to writing the order WITHOUT
--    fulfillment_method, and the status-sync cron (which filters on
--    fulfillment_method='hendylinks') then never sees it — the order sits in
--    'processing' forever. Apply this BEFORE deploying the code.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_method_check
  CHECK (fulfillment_method IN ('auto', 'manual', 'codecraft', 'datakazina', 'kingflexy', 'eazydata', 'agentportal', 'netpulse', 'hendylinks'));

-- 3. Partial indexes so the status-sync cron's filtered scans stay cheap.
CREATE INDEX IF NOT EXISTS idx_orders_hendylinks_processing
  ON orders (fulfillment_method, status)
  WHERE fulfillment_method = 'hendylinks' AND status = 'processing';

CREATE INDEX IF NOT EXISTS idx_shop_orders_hendylinks_processing
  ON shop_orders (fulfilled_by, status)
  WHERE fulfilled_by = 'hendylinks' AND status = 'processing';

-- 4. The webhook and the cron both look an order up by the supplier's id.
CREATE INDEX IF NOT EXISTS idx_orders_hendylinks_reference
  ON orders (hendylinks_reference)
  WHERE hendylinks_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shop_orders_hendylinks_reference
  ON shop_orders (hendylinks_reference)
  WHERE hendylinks_reference IS NOT NULL;
