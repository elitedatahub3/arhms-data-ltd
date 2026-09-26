-- Reports which parts of the Commission Services API migrations are live.
--
-- Both migrations are meant to be safe to re-run, but "ERROR: relation ...
-- already exists" halts the whole script in the SQL editor and leaves you unsure
-- how far the previous attempt got. This answers that without changing anything.
--
-- Read-only. Every row should say OK before /api/v2 is deployed.

WITH checks(part, ok) AS (VALUES

  -- ── Migration 1: 20260903000000_commission_api_v2.sql ────────────────────
  ('1. api_keys.kind column',
   (SELECT to_regclass('public.api_keys') IS NOT NULL AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='api_keys' AND column_name='kind'))),

  ('1. api_keys.webhook_url / webhook_secret',
   (SELECT count(*)=2 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='api_keys'
      AND column_name IN ('webhook_url','webhook_secret'))),

  ('1. old one-key-per-user constraint DROPPED',
   (SELECT NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='api_keys_user_id_unique'))),

  ('1. UNIQUE (user_id, kind) present',
   (SELECT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='api_keys_user_id_kind_unique'))),

  ('1. commission_wallets table',
   (SELECT to_regclass('public.commission_wallets') IS NOT NULL)),

  ('1. commission_transactions table',
   (SELECT to_regclass('public.commission_transactions') IS NOT NULL)),

  ('1. credit_commission_wallet_balance()',
   (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='credit_commission_wallet_balance'))),

  ('1. deduct_commission_wallet_balance()',
   (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='deduct_commission_wallet_balance'))),

  ('1. airtime_orders.api_key_id + commission_credited_at',
   (SELECT count(*)=2 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='airtime_orders'
      AND column_name IN ('api_key_id','commission_credited_at'))),

  ('1. utility_orders.api_key_id + commission_credited_at',
   (SELECT count(*)=2 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='utility_orders'
      AND column_name IN ('api_key_id','commission_credited_at'))),

  ('1. settings: api_v2_enabled / api_commission_enabled',
   (SELECT count(*)=2 FROM public.admin_settings
    WHERE key IN ('api_v2_enabled','api_commission_enabled'))),

  -- ── Migration 2: 20260903010000_commission_api_v2_contract.sql ───────────
  ('2. utility_orders.api_idempotency_key',
   (SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='utility_orders'
      AND column_name='api_idempotency_key'))),

  ('2. per-user idempotency index',
   (SELECT EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_utility_orders_api_idem'))),

  ('2. setting: commission_share_percent',
   (SELECT EXISTS (SELECT 1 FROM public.admin_settings WHERE key='commission_share_percent'))),

  ('2. old commission_share_pct / cap REMOVED',
   (SELECT NOT EXISTS (SELECT 1 FROM public.admin_settings
    WHERE key IN ('commission_share_pct','commission_share_cap_pct')))),

  ('2. settings: utility_api_min/max_amount',
   (SELECT count(*)=2 FROM public.admin_settings
    WHERE key IN ('utility_api_min_amount','utility_api_max_amount'))),

  -- ── Runtime gate, not a migration ────────────────────────────────────────
  ('3. utility_public_launch OPEN (endpoints 403 until true)',
   (SELECT COALESCE((SELECT value FROM public.admin_settings
                     WHERE key='utility_public_launch'),'false') = 'true'))
)
SELECT CASE WHEN ok THEN 'OK    ' ELSE 'MISSING' END AS status, part
FROM checks
ORDER BY part;
