-- Short dealer plans (3 days, 2 weeks, 1 month) with a per-plan on/off switch.
-- The new plans start OFF with no price, so nothing goes on sale until an admin
-- sets a price and switches them on. 3-month / 6-month stay on as before.
INSERT INTO admin_settings (key, value) VALUES
    ('dealer_plan_enabled_3d', 'false'),
    ('dealer_plan_enabled_2w', 'false'),
    ('dealer_plan_enabled_1m', 'false'),
    ('dealer_plan_enabled_3m', 'true'),
    ('dealer_plan_enabled_6m', 'true')
ON CONFLICT (key) DO NOTHING;
