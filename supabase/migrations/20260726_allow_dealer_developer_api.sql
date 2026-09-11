-- Allow dealer accounts to use the Developer API while preserving existing admin access.
UPDATE public.admin_settings
SET value = (
    SELECT jsonb_agg(DISTINCT role ORDER BY role)::text
    FROM jsonb_array_elements_text(
        COALESCE(value::jsonb, '[]'::jsonb) || '["agent","dealer","admin","sub-admin"]'::jsonb
    ) AS roles(role)
)
WHERE key = 'api_allowed_roles';

INSERT INTO public.admin_settings (key, value)
SELECT 'api_allowed_roles', '["agent","dealer","admin","sub-admin"]'
WHERE NOT EXISTS (
    SELECT 1 FROM public.admin_settings WHERE key = 'api_allowed_roles'
);
