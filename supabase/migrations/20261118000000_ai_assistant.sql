-- ============================================================================
-- ARHMS AI — in-app assistant chat history
-- ============================================================================
-- One row per chat message (the user's question or ARHMS AI's reply).
--
--   * The chat route (app/api/ai-assistant/chat) writes with the service role;
--     users may only READ their own rows (to reopen their last conversation).
--   * The per-user daily cap counts role='user' rows since Accra midnight, so it
--     needs no Redis (Upstash is at its monthly quota).
--   * input_tokens / output_tokens on assistant rows feed the admin usage card.
--
-- Settings (admin_settings, upserted by the admin page; absent = defaults):
--   ai_assistant_mode         'off' | 'admins' | 'all'   (default 'off')
--   ai_assistant_daily_limit  messages per user per day  (default 30)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_chat_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL,
    role            text NOT NULL CHECK (role IN ('user', 'assistant')),
    content         text NOT NULL DEFAULT '',
    cards           jsonb,
    input_tokens    integer NOT NULL DEFAULT 0,
    output_tokens   integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_user_created
    ON public.ai_chat_messages (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_conversation
    ON public.ai_chat_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_created
    ON public.ai_chat_messages (created_at DESC);

ALTER TABLE public.ai_chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_chat_messages_select_own" ON public.ai_chat_messages;
CREATE POLICY "ai_chat_messages_select_own"
    ON public.ai_chat_messages
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies: only the service role writes.
