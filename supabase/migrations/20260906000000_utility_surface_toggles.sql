-- Separate switches for where utility bills can be sold.
--
-- Until now `utility_public_launch` was the only gate, and it answered one
-- question: is this product open to anybody but an admin. That was enough when the
-- dashboard was the only place to buy a bill. It is not enough now that shops sell
-- them from their storefronts, because the two surfaces carry different risk and an
-- admin needs to close one without closing the other.
--
-- A storefront sale is the riskier of the two: the buyer is a guest with no account,
-- the shop owner is the account of record, and a reseller chain is being paid. Being
-- able to shut that off while the dashboard keeps working — or open the dashboard to
-- staff while storefronts stay dark — is the point.
--
-- The three now compose:
--
--   utility_public_launch      master. 'false' means admins only, everywhere.
--   utility_dashboard_enabled  the customer dashboard at /dashboard/utilities
--   utility_storefront_enabled shops may sell bills from their storefront
--
-- Both surface switches default to TRUE so this migration changes nothing on its
-- own: whoever could buy a bill before still can, and the master gate keeps doing
-- the job it was doing. An admin opts into the finer control.
INSERT INTO public.admin_settings (key, value) VALUES
    ('utility_dashboard_enabled',  'true'),
    ('utility_storefront_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
