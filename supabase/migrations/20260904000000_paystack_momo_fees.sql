-- Fee percentages for the paystack_momo rail.
--
-- Paystack's mobile money pricing is not its card pricing, so the direct-charge
-- rail gets its own keys rather than inheriting the hosted-checkout ones forever.
-- They are seeded to exactly today's values, so switching a scope over changes the
-- gateway and nothing else — the customer is charged the same figure on day one,
-- and the rate can be tuned afterwards as a separate, visible decision.
--
-- lib/gateway-fees.ts falls back to the paystack_* keys when these are unset, so a
-- deployment that never runs this migration still prices correctly. The seed exists
-- to give an admin something to edit, not to make the code work.

INSERT INTO public.admin_settings (key, value) VALUES
    ('paystack_momo_fee_percent', '1.95'),
    ('agent_paystack_momo_fee_percent', '1.95')
ON CONFLICT (key) DO NOTHING;

-- Mirrors the customer/agent/dealer split already in dual_fee_config_migration.sql
-- and 20260530_dealer_pricing_extensions.sql. shop_global_settings.value is jsonb
-- here, hence to_jsonb() rather than a bare string.
INSERT INTO public.shop_global_settings (key, value) VALUES
    ('shop_paystack_momo_fee_percent',          to_jsonb(1.95)),
    ('shop_paystack_momo_fee_percent_customer', to_jsonb(1.95)),
    ('shop_paystack_momo_fee_percent_agent',    to_jsonb(1.50)),
    ('shop_paystack_momo_fee_percent_dealer',   to_jsonb(1.50))
ON CONFLICT (key) DO NOTHING;
