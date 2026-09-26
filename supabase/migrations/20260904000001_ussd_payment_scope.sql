-- USSD becomes the fourth payment scope, chosen through the same registry as web,
-- shop and classifieds instead of its own ad-hoc key.
--
-- THE VALUE TRANSLATION IS THE POINT OF THIS MIGRATION. ussd_payment_provider =
-- 'paystack' has ALWAYS meant the Charge API — it is the value that makes
-- /api/hubtel/interact call chargeMobileMoney and push a prompt to the handset. It
-- has never meant the hosted checkout page. Under the unified registry those are
-- two different providers, so 'paystack' here becomes 'paystack_momo'.
--
-- Copying it across verbatim would name the hosted-redirect gateway, which cannot
-- complete a USSD sale at all: there is no browser on a dial-in session to redirect.
-- SCOPE_PROVIDERS.ussd omits 'paystack' for that reason, so a verbatim copy would be
-- rejected at resolve time and fall back — silently, on every USSD purchase.
--
-- 'hubtel' carries over unchanged: it is the pre-Paystack AddToCart path and remains
-- the rollback.

INSERT INTO public.admin_settings (key, value)
SELECT
    'active_payment_provider_ussd',
    CASE
        WHEN trim(both '"' from value #>> '{}') = 'hubtel' THEN '"hubtel"'::jsonb
        ELSE '"paystack_momo"'::jsonb
    END
FROM public.admin_settings
WHERE key = 'ussd_payment_provider'
ON CONFLICT (key) DO NOTHING;

-- If ussd_payment_provider was never seeded, default to the live gateway. Unlike
-- ussd_enabled this switch does not decide WHETHER to take money, only which gateway
-- takes it, so a missing row must route to the rail that works rather than strand a
-- caller on the retired one.
INSERT INTO public.admin_settings (key, value)
VALUES ('active_payment_provider_ussd', '"paystack_momo"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ussd_payment_provider is deliberately LEFT IN PLACE for one release. Nothing reads
-- it after this ships, but it records what the channel was set to before the cutover
-- and is the fastest thing to consult if the new key looks wrong. Drop it in a
-- follow-up once the scope has been exercised in production.
