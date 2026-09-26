-- AFA registration and Results Checker over the v2 API.
--
-- Same attribution column the data, airtime and utility tables already carry (see
-- 20260528_developer_api.sql and 20260903000000_commission_api_v2.sql): it is what
-- tells an API-placed order apart from a dashboard or storefront one, both for the
-- admin queues and for the idempotency lookup, which is scoped to the calling key
-- before falling back to the user.
--
-- No commission_credited_at here, unlike airtime/utility. Neither product pays a
-- commission share: AFA is a flat admin-set fee and a Results Checker sells from
-- stock we already bought, so there is nothing to split.

ALTER TABLE public.afa_orders
    ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES public.api_keys(id) ON DELETE SET NULL;

ALTER TABLE public.results_checker_orders
    ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES public.api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_afa_orders_api_key ON public.afa_orders(api_key_id);
CREATE INDEX IF NOT EXISTS idx_results_checker_orders_api_key ON public.results_checker_orders(api_key_id);
