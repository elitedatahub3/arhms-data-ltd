-- Developer API: api_keys, api_logs tables + orders table extensions

-- ─── api_keys ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_keys (
    id           UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id      UUID        REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    key_hash     TEXT        NOT NULL,
    key_prefix   TEXT        NOT NULL,
    name         TEXT        NOT NULL DEFAULT 'My API Key',
    status       TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'active', 'revoked')),
    rate_limits  JSONB,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT api_keys_user_id_unique UNIQUE (user_id),
    CONSTRAINT api_keys_prefix_unique  UNIQUE (key_prefix)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON public.api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status  ON public.api_keys(status);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix  ON public.api_keys(key_prefix);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "api_keys: user select own" ON public.api_keys FOR SELECT USING (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "api_keys: user insert own" ON public.api_keys FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "api_keys: user delete own" ON public.api_keys FOR DELETE USING (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "api_keys: admin full access" ON public.api_keys FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── api_logs ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_logs (
    id               UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    api_key_id       UUID        REFERENCES public.api_keys(id) ON DELETE SET NULL,
    user_id          UUID        REFERENCES public.users(id)    ON DELETE SET NULL,
    endpoint         TEXT        NOT NULL,
    method           TEXT        NOT NULL,
    status_code      INTEGER     NOT NULL,
    response_time_ms INTEGER,
    ip_address       TEXT,
    error_message    TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_logs_api_key_id ON public.api_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_user_id    ON public.api_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON public.api_logs(created_at DESC);

ALTER TABLE public.api_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "api_logs: admin read all" ON public.api_logs FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "api_logs: user read own" ON public.api_logs FOR SELECT USING (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "api_logs: service insert" ON public.api_logs FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Extend orders table ──────────────────────────────────────────────────────
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS source       TEXT DEFAULT 'web';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS api_key_id   UUID REFERENCES public.api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_source     ON public.orders(source);
CREATE INDEX IF NOT EXISTS idx_orders_api_key_id ON public.orders(api_key_id);

-- ─── Admin settings ───────────────────────────────────────────────────────────
INSERT INTO public.admin_settings (key, value) VALUES
    ('api_feature_enabled', 'true'),
    ('api_allowed_roles',   '["agent","dealer","admin","sub-admin"]'),
    ('api_rate_limits',     '{"purchase":20,"bulk":10,"balance":60,"status":60}')
ON CONFLICT (key) DO NOTHING;

-- Ensure admin/sub-admin are always in the allowed roles list (idempotent upsert)
INSERT INTO public.admin_settings (key, value) VALUES ('api_allowed_roles', '["agent","dealer","admin","sub-admin"]')
ON CONFLICT (key) DO UPDATE SET value = '["agent","dealer","admin","sub-admin"]';
