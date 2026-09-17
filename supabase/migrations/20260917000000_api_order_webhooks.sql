-- Webhook delivery for API-created data and AFA orders.
--
-- Airtime and bill payments already notify the partner from finalizeAirtimeOrder /
-- finalizeUtilityOrder. Data and AFA orders have no such chokepoint: they reach a
-- terminal state in roughly twenty-five places — supplier webhooks, eight sync crons,
-- admin fulfilment, refulfil, batch, refund, datagod — and instrumenting each one
-- would still miss whichever supplier is added next. A sweeper reads the rows instead:
-- one place to get right, and a new fulfilment path is covered without touching it.
--
-- api_webhook_sent_at records the ATTEMPT, not a confirmed 2xx. Delivery already
-- retries three times within a run, and a partner whose endpoint is down must not pin
-- the sweeper to the same row on every pass.

ALTER TABLE orders     ADD COLUMN IF NOT EXISTS api_webhook_sent_at timestamptz;
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS api_webhook_sent_at timestamptz;

-- Mark everything already terminal as handled. Without this the first run would fire a
-- webhook for every API order ever completed — months of history, delivered at once, to
-- an endpoint expecting live traffic.
UPDATE orders
   SET api_webhook_sent_at = now()
 WHERE api_key_id IS NOT NULL
   AND status IN ('completed', 'failed')
   AND api_webhook_sent_at IS NULL;

UPDATE afa_orders
   SET api_webhook_sent_at = now()
 WHERE api_key_id IS NOT NULL
   AND status IN ('completed', 'failed')
   AND api_webhook_sent_at IS NULL;

-- Partial indexes matching the sweeper's predicate exactly, so each run reads only the
-- outstanding rows rather than scanning a table that is almost entirely settled.
CREATE INDEX IF NOT EXISTS orders_api_webhook_pending_idx
    ON orders (updated_at)
    WHERE api_key_id IS NOT NULL
      AND api_webhook_sent_at IS NULL
      AND status IN ('completed', 'failed');

CREATE INDEX IF NOT EXISTS afa_orders_api_webhook_pending_idx
    ON afa_orders (updated_at)
    WHERE api_key_id IS NOT NULL
      AND api_webhook_sent_at IS NULL
      AND status IN ('completed', 'failed');
