-- ============================================================
-- Separate SMS accounts for the shop and the SMS Platform
--
-- The shop's Customer SMS and the SMS Platform are different products. Until
-- now a user had ONE sms_accounts row that both used, so credits, sender IDs,
-- contacts, groups and records showed up in both. From here each user has one
-- account per product:
--
--   scope = 'shop'      the shop / sub-agent Customer SMS (every existing row)
--   scope = 'platform'  the SMS Platform at /dashboard/sms (created on first use)
--
-- Existing credits, sender IDs, contacts and records stay with the shop, where
-- they were bought and used. Business registrations are a platform concept, so
-- they move to the owner's (new) platform account, keeping Business Mode.
--
-- Safe to run more than once.
-- ============================================================


-- ─── scope ───────────────────────────────────────────────────────────────────
ALTER TABLE public.sms_accounts
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'shop';

DO $$ BEGIN
    ALTER TABLE public.sms_accounts
        ADD CONSTRAINT sms_accounts_scope_check CHECK (scope IN ('shop', 'platform'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One account per user per product, instead of one per user.
ALTER TABLE public.sms_accounts DROP CONSTRAINT IF EXISTS sms_accounts_user_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS sms_accounts_user_scope_unique
    ON public.sms_accounts (user_id, scope);


-- ─── Business registrations move to the platform account ─────────────────────
-- Only when the sms_businesses table exists (20261010000000_sms_platform.sql).
DO $$ BEGIN
    IF to_regclass('public.sms_businesses') IS NOT NULL THEN
        -- A platform account for every owner who registered a business.
        INSERT INTO public.sms_accounts (user_id, shop_id, scope, status, mode, unlocked_at, unlock_amount)
        SELECT s.user_id, s.shop_id, 'platform', 'active', s.mode, NOW(), 0
          FROM public.sms_businesses b
          JOIN public.sms_accounts s ON s.id = b.account_id AND s.scope = 'shop'
        ON CONFLICT (user_id, scope) DO NOTHING;

        UPDATE public.sms_businesses b
           SET account_id = p.id, updated_at = NOW()
          FROM public.sms_accounts s, public.sms_accounts p
         WHERE b.account_id = s.id
           AND s.scope = 'shop'
           AND p.user_id = s.user_id
           AND p.scope = 'platform';
    END IF;
END $$;

-- Business Mode belongs to the platform account; a shop account is never in it.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'sms_accounts' AND column_name = 'mode') THEN
        UPDATE public.sms_accounts SET mode = 'platform' WHERE scope = 'shop' AND mode <> 'platform';
    END IF;
END $$;


-- ─── Sender ID ownership ─────────────────────────────────────────────────────
-- A sender ID still belongs to one business at the network, but the same owner
-- may now hold it on both their shop and platform accounts. The global unique
-- index cannot express "same owner", so the rule moves to the application
-- (senderClaimedByOtherUser in lib/sms/customer-sms.ts); a plain index keeps
-- the lookup fast.
DROP INDEX IF EXISTS public.idx_sms_sender_ids_claimed;
CREATE INDEX IF NOT EXISTS idx_sms_sender_ids_lower_sender
    ON public.sms_sender_ids (lower(sender));
