-- Agent Portal GH supplier: DB objects the integration references.

-- 1. Columns to store the reference we correlate Agent Portal orders by.
--    Agent Portal returns no transaction id on submit, so we send the Arhms order
--    id as the `reference` and store it here. The webhook receiver and the fallback
--    status-sync cron read these to match completions back to orders.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS agentportal_reference TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS agentportal_reference TEXT;

-- 2. Allow 'agentportal' as a fulfillment_method on orders.
--    Without this, stamping fulfillment_method='agentportal' violates the CHECK
--    constraint and the order can't be picked up by the agentportal status-sync
--    cron (which filters on fulfillment_method='agentportal').
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_method_check
  CHECK (fulfillment_method IN ('auto', 'manual', 'codecraft', 'datakazina', 'kingflexy', 'eazydata', 'agentportal'));
