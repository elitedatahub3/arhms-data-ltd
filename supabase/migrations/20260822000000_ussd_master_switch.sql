-- ============================================================
-- USSD master switch
--
-- One key takes the whole USSD stack off the air: the dial-in service
-- (/api/hubtel/interact), the sale of short codes (/api/shop/ussd/activate) and
-- every surface that advertises either. Flipped in /admin/settings, no deploy.
--
-- Seeded 'false' — this migration ships alongside the deactivation. The
-- application already treats a missing row as OFF (see lib/ussd-availability.ts,
-- which fails closed), so this row is what makes the state visible and
-- reversible from the admin UI rather than what keeps the door shut.
--
-- Note the dial code itself lives in the Hubtel dashboard, not here. Turning
-- this off does not stop the phone ringing; it makes every session hang up with
-- USSD_OFFLINE_MESSAGE instead of selling anything.
-- ============================================================

INSERT INTO public.admin_settings (key, value) VALUES
    ('ussd_enabled', 'false')
ON CONFLICT (key) DO NOTHING;


-- Recreate the public-safe settings view with the new key added, so the
-- dashboard and sub-portal navs (anon client, via getPublicConfig) can read the
-- flag and drop their USSD links.
--
-- The key list below is the previous definition (20260708_landing_rc_only_toggle)
-- plus 'ussd_enabled', deliberately unchanged otherwise: lib/public-config.ts
-- also asks for 'page_access_utilities' and 'storefront_mashup_enabled', which
-- this view has never exposed. Both default safely when absent, and widening the
-- view is a separate decision from switching USSD off.
create or replace view public.public_admin_settings as
select key, value
from public.admin_settings
where key in (
  'guest_storefront_url',
  'whatsapp_group_link',
  'whatsapp_channel_link',
  'whatsapp_admin_number',
  'whatsapp_community_link',
  'support_email',
  'footer_copyright_text',
  'footer_branding_text',
  'announcement_enabled',
  'announcement_title',
  'announcement_message',
  'agent_upgrade_price_3d',
  'agent_upgrade_price_14d',
  'agent_upgrade_price_30d',
  'agent_upgrade_price_permanent',
  'agent_upgrade_price_3d_old',
  'agent_upgrade_price_14d_old',
  'agent_upgrade_price_30d_old',
  'agent_upgrade_price_permanent_old',
  'show_price_strikethrough',
  'page_access_dashboard',
  'page_access_data_packages',
  'page_access_orders',
  'page_access_wallet',
  'page_access_complaints',
  'page_access_notifications',
  'page_access_profile',
  'page_access_shop',
  'page_access_storefront',
  'page_access_airtime',
  'storefront_airtime_enabled',
  'airtime_fee_mtn_customer',
  'airtime_fee_mtn_agent',
  'airtime_fee_telecel_customer',
  'airtime_fee_telecel_agent',
  'airtime_fee_at_customer',
  'airtime_fee_at_agent',
  'airtime_min_amount',
  'airtime_max_amount',
  'airtime_enabled_mtn',
  'airtime_enabled_telecel',
  'airtime_enabled_at',
  'landing_rc_only_enabled',
  'ussd_enabled'
);

grant select on public.public_admin_settings to anon, authenticated;
