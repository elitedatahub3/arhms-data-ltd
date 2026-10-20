-- ════════════════════════════════════════════════════════════════════════════
-- Retire the Refer & Earn programme
--
-- The code is gone (pages, /api/referrals/*, admin Referrals page, signup field,
-- ?ref= capture). But bonuses were paid by a DATABASE trigger, not by the app,
-- so removing the code alone would keep crediting referrers on every completed
-- order. This stops that:
--   * referral_bonus_enabled forced off (pay_referral_bonus checks it first);
--   * trg_credit_referral_bonus dropped, so nothing calls it on completion;
--   * trg_assign_referral_code dropped, so new users stop getting codes.
--
-- Kept on purpose:
--   * trg_reverse_referral_bonus — a bonus ALREADY paid is still clawed back if
--     its order is refunded later;
--   * every table, column and function, and all past wallet transactions with
--     source = 'referral', so history and reporting stay intact.
--
-- Run with or right after deploying the matching code.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO public.admin_settings (key, value)
VALUES ('referral_bonus_enabled', '"false"')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

DROP TRIGGER IF EXISTS trg_credit_referral_bonus ON public.orders;
DROP TRIGGER IF EXISTS trg_assign_referral_code ON public.users;
