-- Lets the KingFlexy webhook find an order by the supplier's own reference.
--
-- Bill payments now dispatch to KingFlexy rather than Hubtel, and KingFlexy
-- generates its own order code (UTIL-<BILLER>-<hex>) which it returns from /pay and
-- expects back on its status endpoint. We store that in the existing
-- external_transaction_id column -- no new column needed -- but both the callback
-- handler and the reconciliation cron look orders up by it, so it needs an index.
--
-- Partial, because only orders that were actually dispatched carry one, and the
-- lookups only ever target those.
CREATE INDEX IF NOT EXISTS idx_utility_orders_external_txn
    ON public.utility_orders(external_transaction_id)
    WHERE external_transaction_id IS NOT NULL;
