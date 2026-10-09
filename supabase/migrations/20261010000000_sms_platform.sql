-- ============================================================
-- SMS Platform
--
-- Opens Customer SMS to every user as a standalone product, and adds what a
-- bulk SMS platform needs on top of it:
--
--   * Platform Mode (default) vs Business Mode on the account. Business Mode is
--     earned by registering a business and having an admin approve it; it lifts
--     the daily limit and allows links in messages.
--   * sms_businesses — the business registration an admin reviews.
--   * sms_sender_ids.kind — how a sender ID was vetted.
--   * api_keys.kind 'sms' — a developer key that can only send SMS.
--
-- Everything is additive. The application reads `mode` and `sms_businesses`
-- defensively, so deploying the code before this runs leaves every account in
-- Platform Mode rather than breaking Customer SMS.
-- ============================================================


-- ─── sms_accounts.mode ───────────────────────────────────────────────────────
ALTER TABLE public.sms_accounts
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'platform';

DO $$ BEGIN
    ALTER TABLE public.sms_accounts
        ADD CONSTRAINT sms_accounts_mode_check CHECK (mode IN ('platform', 'business'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ─── sms_sender_ids.kind ─────────────────────────────────────────────────────
-- 'platform': requested without documents from a Platform Mode account.
-- 'business': requested by an account whose business registration is approved.
-- Existing rows predate the distinction; they were requested with a business
-- name and optional Ghana Card, which is the platform flow.
ALTER TABLE public.sms_sender_ids
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'platform';

DO $$ BEGIN
    ALTER TABLE public.sms_sender_ids
        ADD CONSTRAINT sms_sender_ids_kind_check CHECK (kind IN ('platform', 'business'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ─── sms_businesses ──────────────────────────────────────────────────────────
-- One registration per account. Only the last four digits of the Ghana Card
-- are kept: the full number is checked for shape on the way in and dropped.
--
-- draft    → saved, not yet sent for review
-- pending  → submitted, waiting for an admin
-- approved → verified; the account is in Business Mode
-- rejected → refused with a reason; the owner can edit and resubmit
CREATE TABLE IF NOT EXISTS public.sms_businesses (
    id               UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    account_id       UUID        REFERENCES public.sms_accounts(id) ON DELETE CASCADE NOT NULL,
    business_name    TEXT        NOT NULL CHECK (char_length(business_name) BETWEEN 2 AND 120),
    description      TEXT        NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
    domain           TEXT,
    ghana_card_last4 TEXT        CHECK (ghana_card_last4 IS NULL OR ghana_card_last4 ~ '^[0-9]{4}$'),
    whatsapp         TEXT        CHECK (whatsapp IS NULL OR whatsapp ~ '^233[0-9]{9}$'),
    status           TEXT        NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
    rejection_reason TEXT,
    submitted_at     TIMESTAMPTZ,
    reviewed_at      TIMESTAMPTZ,
    reviewed_by      UUID        REFERENCES public.users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT sms_businesses_account_unique UNIQUE (account_id)
);

CREATE INDEX IF NOT EXISTS idx_sms_businesses_status
    ON public.sms_businesses(status, submitted_at);

ALTER TABLE public.sms_businesses ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "sms_businesses: owner select" ON public.sms_businesses FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.id = account_id AND a.user_id = (SELECT auth.uid())));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "sms_businesses: admin all" ON public.sms_businesses FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ─── Review decisions, atomically ────────────────────────────────────────────
-- Approving flips the registration and the account's mode together, so there
-- is never an approved business on a Platform Mode account or the reverse.
-- Only a pending registration can be decided, which makes a double click a
-- no-op instead of a second notification.
CREATE OR REPLACE FUNCTION public.review_sms_business(
    p_business_id UUID,
    p_admin_id    UUID,
    p_approve     BOOLEAN,
    p_reason      TEXT DEFAULT NULL
)
RETURNS TABLE (account_id UUID, user_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_account UUID;
    v_user    UUID;
    v_status  TEXT := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
BEGIN
    UPDATE public.sms_businesses b
       SET status           = v_status,
           rejection_reason = CASE WHEN p_approve THEN NULL ELSE NULLIF(trim(p_reason), '') END,
           reviewed_at      = NOW(),
           reviewed_by      = p_admin_id,
           updated_at       = NOW()
     WHERE b.id = p_business_id
       AND b.status = 'pending'
    RETURNING b.account_id INTO v_account;

    IF v_account IS NULL THEN
        RAISE EXCEPTION 'NOT_PENDING';
    END IF;

    UPDATE public.sms_accounts a
       SET mode       = CASE WHEN p_approve THEN 'business' ELSE 'platform' END,
           updated_at = NOW()
     WHERE a.id = v_account
    RETURNING a.user_id INTO v_user;

    RETURN QUERY SELECT v_account, v_user, v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.review_sms_business(UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_business(UUID, UUID, BOOLEAN, TEXT) TO service_role;


-- ─── api_keys.kind 'sms' ─────────────────────────────────────────────────────
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_kind_check;
ALTER TABLE public.api_keys
    ADD CONSTRAINT api_keys_kind_check CHECK (kind IN ('standard', 'commission', 'sms'));


-- ─── Settings ────────────────────────────────────────────────────────────────
-- Daily recipient limits per mode (0 = unlimited) and sender ID caps. Values
-- are placeholders until the real numbers are decided in admin.
INSERT INTO public.admin_settings (key, value)
VALUES
    ('sms_daily_limit_platform', '"1000"'),
    ('sms_daily_limit_business', '"0"'),
    ('sms_sender_cap_platform',  '"3"'),
    ('sms_sender_cap_business',  '"200"'),
    -- 233XXXXXXXXX; left empty the documents box is hidden.
    ('sms_business_docs_whatsapp', '""')
ON CONFLICT (key) DO NOTHING;
