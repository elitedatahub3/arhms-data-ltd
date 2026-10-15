-- API users: an admin-controlled switch on the account, separate from its role.
--
-- An admin turns it on from /admin/users ("Make API User"). Only API users can
-- call the developer API with a standard key (admins excepted), and they pay the
-- admin-set API prices from 20261015000000_api_prices.sql — over the API and on the
-- dashboard for data, results checker and AFA. See lib/api-pricing.ts.
--
-- Every account that already holds an approved key is switched on here, so no live
-- integration starts getting 403 when this ships.
--
-- Safe to run more than once. Until it runs, the code treats everyone as "not an
-- API user" on the dashboard and skips the API gate (all reads use select('*')).

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS is_api_user boolean NOT NULL DEFAULT false;

UPDATE public.users u
SET is_api_user = true
WHERE u.is_api_user = false
  AND EXISTS (
      SELECT 1 FROM public.api_keys k
      WHERE k.user_id = u.id
        AND k.status = 'active'
        AND COALESCE(k.kind, 'standard') = 'standard'
  );

CREATE INDEX IF NOT EXISTS users_is_api_user_idx
    ON public.users (is_api_user)
    WHERE is_api_user;

-- "Users can update own profile" lets a signed-in user write any column of their
-- own row, so without this guard anyone could switch themselves on from the
-- browser. Only the service role (the admin endpoint /api/admin/users/api-user)
-- or SQL run outside a user session may set it.
CREATE OR REPLACE FUNCTION public.guard_is_api_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF COALESCE(auth.role(), '') IN ('authenticated', 'anon') THEN
        IF TG_OP = 'INSERT' AND NEW.is_api_user THEN
            RAISE EXCEPTION 'is_api_user can only be set by an admin' USING ERRCODE = '42501';
        ELSIF TG_OP = 'UPDATE' AND NEW.is_api_user IS DISTINCT FROM OLD.is_api_user THEN
            RAISE EXCEPTION 'is_api_user can only be set by an admin' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_is_api_user ON public.users;
CREATE TRIGGER guard_is_api_user
    BEFORE INSERT OR UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.guard_is_api_user();

NOTIFY pgrst, 'reload schema';
